#include "omega/runtime/models/model_quantize_service.hpp"

#include "omega/runtime/paths.hpp"

#include <cstdio>
#include <filesystem>
#include <map>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string models_root(ConfigStore& config) {
  const json cfg = config.load();
  if (cfg.contains("modelsDir") && cfg["modelsDir"].is_string()) {
    const std::string dir = cfg["modelsDir"].get<std::string>();
    if (!dir.empty()) return dir;
  }
  return models_dir();
}

#ifdef _WIN32
int run_process_capture(const std::string& cmd, std::string& stderr_out) {
  FILE* pipe = _popen(cmd.c_str(), "r");
  if (!pipe) return -1;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) stderr_out += buf;
  return _pclose(pipe);
}
#endif

}  // namespace

ModelQuantizeService::ModelQuantizeService(ConfigStore& config, EventBus& events)
    : config_(config), events_(events) {}

void ModelQuantizeService::emit_progress(const std::string& status, int percent,
                                         const std::string& message) const {
  const json p = json{{"status", status}, {"percent", percent}, {"message", message}};
  events_.publish("omega:quantize:progress", p);
}

json ModelQuantizeService::quantize(const json& req) {
  const std::string input = req.value("inputPath", "");
  const std::string output_name = req.value("outputName", "");
  const std::string quant = req.value("quant", "Q4_K_M");
  if (input.empty() || output_name.empty()) {
    throw std::runtime_error("inputPath and outputName are required");
  }
  if (!fs::exists(input)) throw std::runtime_error("input not found: " + input);

  const std::string bin = resolve_quantize_binary();
  if (bin.empty() || !fs::exists(bin)) {
    emit_progress("error", 0,
                  "llama-quantize not bundled. Run scripts/fetch-infer-binaries.ps1 before build.");
    throw std::runtime_error("llama-quantize not found");
  }

  static const std::map<std::string, std::string> kQuant{
      {"Q4_K_M", "Q4_K_M"}, {"Q5_K_M", "Q5_K_M"}, {"Q8_0", "Q8_0"}, {"F16", "F16"}};
  const std::string qtype = kQuant.count(quant) ? kQuant.at(quant) : "Q4_K_M";
  const fs::path out_path = fs::path(models_root(config_)) / (output_name + ".gguf");

  emit_progress("running", 10, "Quantizing to " + qtype + "…");

  std::string cmd = "\"" + bin + "\" \"" + input + "\" \"" + out_path.string() + "\" " + qtype;
  if (req.contains("tensorTypeFile") && req["tensorTypeFile"].is_string()) {
    cmd += " --tensor-type-file \"" + req["tensorTypeFile"].get<std::string>() + "\"";
  }
  if (req.contains("tensorTypes") && req["tensorTypes"].is_array()) {
    for (const auto& tt : req["tensorTypes"]) {
      if (!tt.is_object()) continue;
      const std::string pattern = tt.value("pattern", "");
      const std::string ggml = tt.value("ggmlType", "");
      if (!pattern.empty() && !ggml.empty()) {
        cmd += " --tensor-type " + pattern + "=" + ggml;
      }
    }
  }
  cmd += " 2>&1";

  std::string stderr_out;
  int code = -1;
#ifdef _WIN32
  code = run_process_capture(cmd, stderr_out);
#else
  code = std::system(cmd.c_str());
#endif

  if (code != 0) {
    const std::string msg = stderr_out.empty() ? ("quantize failed: exit " + std::to_string(code))
                                               : stderr_out;
    emit_progress("error", 0, msg);
    throw std::runtime_error(msg);
  }

  emit_progress("complete", 100, out_path.string());
  events_.publish("omega:models:inventoryChanged", json::object());
  return json{{"path", out_path.string()}};
}

}  // namespace omega::runtime
