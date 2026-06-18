#include "omega/runtime/models/model_meta_service.hpp"

#include "omega/runtime/models/gguf_metadata.hpp"
#include "omega/runtime/paths.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <regex>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

double quant_bytes_per_param(const std::string& q) {
  if (q.empty()) return 0.5;
  std::string norm = q;
  for (auto& c : norm) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
  static const struct {
    const char* key;
    double val;
  } k_table[] = {{"F32", 4},   {"F16", 2},     {"BF16", 2},    {"Q8_0", 1.06}, {"Q4_K_M", 0.56},
                 {"Q4_0", 0.56}, {"Q5_K_M", 0.69}, {"Q3_K_M", 0.42}, {"Q2_K", 0.34}};
  for (const auto& row : k_table) {
    if (norm == row.key) return row.val;
  }
  return 0.5;
}

double kv_bytes(const std::string& cache_type) {
  if (cache_type == "f32") return 4;
  if (cache_type == "q8_0") return 1;
  if (cache_type == "q4_0") return 0.5;
  return 2;
}

}  // namespace

ModelMetaService::ModelMetaService(ConfigStore& config, ModelConfigStore& model_config,
                                   EngineClient& engine)
    : config_(config), model_config_(model_config), engine_(engine) {}

std::string ModelMetaService::quant_from_name(const std::string& model_id) {
  static const std::regex re(R"((IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|F16|F32|BF16))", std::regex::icase);
  std::smatch m;
  if (std::regex_search(model_id, m, re)) return m[1].str();
  return {};
}

std::string ModelMetaService::resolve_path(const std::string& model_id) const {
  const json cfg = config_.load();
  const fs::path dir = cfg.value("modelsDir", models_dir());
  const fs::path direct = dir / (model_id + ".gguf");
  if (fs::exists(direct)) return direct.string();
  const fs::path alt = dir / model_id;
  if (fs::exists(alt) && alt.extension() == ".gguf") return alt.string();
  const fs::path pack = dir / model_id;
  if (fs::is_directory(pack)) {
    for (const auto& entry : fs::directory_iterator(pack)) {
      if (entry.is_regular_file() && entry.path().extension() == ".gguf") return entry.path().string();
    }
  }
  return {};
}

json ModelMetaService::inspect(const std::string& model_id) const {
  const std::string path = resolve_path(model_id);
  if (path.empty()) throw std::runtime_error("model not found: " + model_id);
  const int64_t size = static_cast<int64_t>(fs::file_size(path));
  json out{{"id", model_id},
           {"fileSize", size},
           {"quantization", quant_from_name(model_id)}};
  if (const auto meta = read_safe_gguf_metadata(path)) {
    if (!meta->architecture.empty()) out["architecture"] = meta->architecture;
    if (meta->parameter_count) out["parameterCount"] = *meta->parameter_count;
    if (meta->total_layers) out["totalLayers"] = *meta->total_layers;
    if (meta->context_length_max) out["contextLengthMax"] = *meta->context_length_max;
    if (meta->embedding_length) out["embeddingLength"] = *meta->embedding_length;
    if (!meta->quantization.empty()) out["quantization"] = meta->quantization;
  }
  if (!out.contains("totalLayers")) out["totalLayers"] = 32;
  if (!out.contains("contextLengthMax")) out["contextLengthMax"] = 32768;
  if (!out.contains("embeddingLength")) out["embeddingLength"] = 4096;
  return out;
}

json ModelMetaService::estimate_file(int64_t size_bytes, int context,
                                     const std::string& quant) const {
  const double file_mb = static_cast<double>(size_bytes) / (1024.0 * 1024.0);
  const double bpp = quant_bytes_per_param(quant);
  const double params_b = bpp > 0 ? file_mb / 1024.0 / bpp : file_mb / 1024.0 / 0.5;
  int layers = 32;
  int embed = 4096;
  if (params_b >= 60) {
    layers = 80;
    embed = 8192;
  } else if (params_b >= 25) {
    layers = 64;
    embed = 8192;
  } else if (params_b >= 12) {
    layers = 48;
    embed = 5120;
  } else if (params_b >= 6) {
    layers = 32;
    embed = 4096;
  } else if (params_b >= 2) {
    layers = 24;
    embed = 2048;
  } else {
    layers = 16;
    embed = 2048;
  }
  const double kv_cache_mb = (context * embed * 4.0 * layers) / (1024.0 * 1024.0);
  const double weights_mb = file_mb * 1.05;
  const int vram_mb = static_cast<int>(std::lround(weights_mb + kv_cache_mb + 256));
  const int ram_mb = static_cast<int>(std::lround(weights_mb + kv_cache_mb + 200));
  return json{{"weightsMb", static_cast<int>(std::lround(weights_mb))},
              {"kvCacheMb", static_cast<int>(std::lround(kv_cache_mb))},
              {"vramMb", vram_mb},
              {"ramMbIfCpu", ram_mb}};
}

json ModelMetaService::estimate(const std::string& model_id, const json& config, int gpu_total_mb,
                                int gpu_budget_mb) const {
  const json meta = inspect(model_id);
  const int total_layers = meta.value("totalLayers", 32);
  const double file_mb = meta.value("fileSize", 0) / (1024.0 * 1024.0);
  const double per_layer_mb = file_mb / std::max(1, total_layers + 1);
  const int gpu_layers = std::min(config.value("gpuLayers", 999), total_layers + 1);
  const int cpu_layers = std::max(0, total_layers + 1 - gpu_layers);
  const int ctx = config.value("contextSize", 4096);
  const int embed = meta.value("embeddingLength", 4096);
  const double k_bytes = kv_bytes(config.value("kCacheType", "f16"));
  const double v_bytes = kv_bytes(config.value("vCacheType", "f16"));
  const double kv_cache_mb = (ctx * embed * (k_bytes + v_bytes) * total_layers) / (1024.0 * 1024.0);
  const bool kv_on_gpu = config.value("kvCacheOnGpu", true);
  const double gpu_mb = gpu_layers * per_layer_mb + (kv_on_gpu ? kv_cache_mb : 0) + 256;
  const double cpu_ram_mb = cpu_layers * per_layer_mb + (kv_on_gpu ? 0 : kv_cache_mb) + 200;
  json out{{"gpuMb", static_cast<int>(std::lround(gpu_mb))},
           {"cpuRamMb", static_cast<int>(std::lround(cpu_ram_mb))},
           {"totalMb", static_cast<int>(std::lround(gpu_mb + cpu_ram_mb))},
           {"perLayerMb", std::round(per_layer_mb * 10.0) / 10.0},
           {"kvCacheMb", static_cast<int>(std::lround(kv_cache_mb))},
           {"fitsInGpu", gpu_total_mb <= 0 ? true : gpu_mb <= gpu_total_mb}};
  if (gpu_budget_mb > 0) {
    out["fitsInBudget"] = gpu_mb <= gpu_budget_mb;
    out["gpuBudgetMb"] = gpu_budget_mb;
  }
  return out;
}

json ModelMetaService::footprint(const std::string& model_id) const {
  const std::string path = resolve_path(model_id);
  if (path.empty()) throw std::runtime_error("model not found: " + model_id);
  const int64_t size = static_cast<int64_t>(fs::file_size(path));
  const double size_gb = static_cast<double>(size) / (1024.0 * 1024.0 * 1024.0);
  const double vram_gb = size_gb * 1.15 + 0.5;
  return json{{"model", model_id},
              {"file_size_bytes", size},
              {"file_size_gb", std::round(size_gb * 100.0) / 100.0},
              {"estimated_vram_gb", std::round(vram_gb * 100.0) / 100.0},
              {"note", "Estimate assumes full GPU offload; actual VRAM depends on layers and context."}};
}

json ModelMetaService::benchmark(const std::string& model_id) {
  const auto start = std::chrono::steady_clock::now();
  const json body{{"model", model_id},
                  {"messages", json::array({json{{"role", "user"}, {"content", "The capital of France is"}}})},
                  {"sampling", json{{"max_tokens", 64}, {"temperature", 0.1}}}};
  const json result = engine_.command("chat.generate", body, 120000);
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::steady_clock::now() - start)
                      .count();
  const int tokens_out = result.value("tokens_out", result.value("completion_tokens", 0));
  const double tps = ms > 0 ? (tokens_out * 1000.0 / ms) : 0;
  std::string sample = result.value("text", "");
  if (sample.size() > 200) sample = sample.substr(0, 200);
  return json{{"model", model_id},
              {"prompt_tokens", result.value("tokens_in", 0)},
              {"completion_tokens", tokens_out},
              {"latency_ms", ms},
              {"tokens_per_sec", std::round(tps * 100.0) / 100.0},
              {"sample", sample}};
}

}  // namespace omega::runtime
