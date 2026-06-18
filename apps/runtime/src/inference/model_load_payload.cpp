#include "omega/runtime/inference/model_load_payload.hpp"

#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/storage/model_config_store.hpp"

#include <algorithm>
#include <vector>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

bool model_keys_match(const std::string& a, const std::string& b) {
  if (a.empty() || b.empty()) return false;
  if (a == b) return true;
  const auto stem = [](std::string id) {
    const size_t slash = id.find_last_of("/\\");
    if (slash != std::string::npos) id = id.substr(slash + 1);
    const size_t dot = id.rfind('.');
    if (dot != std::string::npos) id = id.substr(0, dot);
    return id;
  };
  return stem(a) == stem(b);
}

json merge_model_settings(const json& base, const json& overlay) {
  json out = base;
  if (!overlay.is_object()) return out;
  for (auto it = overlay.begin(); it != overlay.end(); ++it) {
    out[it.key()] = it.value();
  }
  return out;
}

}  // namespace

json resolve_model_settings(ConfigStore& config, const std::string& model_id) {
  ModelConfigStore store;
  json settings = store.get(model_id);
  const json cfg = config.load();
  if (!model_id.empty() && cfg.contains("modelConfigs") && cfg["modelConfigs"].is_object()) {
    for (auto it = cfg["modelConfigs"].begin(); it != cfg["modelConfigs"].end(); ++it) {
      if (model_keys_match(model_id, it.key())) {
        settings = merge_model_settings(settings, it.value());
        break;
      }
    }
  }
  return settings;
}

json build_engine_load_options(ConfigStore& config, const std::string& model_id) {
  const json mc = resolve_model_settings(config, model_id);
  json out = json::object();
  if (mc.contains("contextSize") && mc["contextSize"].is_number_integer()) {
    out["context_size"] = mc["contextSize"];
  }
  if (mc.contains("gpuLayers") && mc["gpuLayers"].is_number_integer()) {
    out["gpu_layers"] = mc["gpuLayers"];
  }
  if (mc.contains("batchSize") && mc["batchSize"].is_number_integer()) {
    out["batch_size"] = mc["batchSize"];
  }
  if (mc.contains("threads") && mc["threads"].is_number_integer()) {
    out["threads"] = mc["threads"];
  }
  if (mc.contains("mainGpu") && mc["mainGpu"].is_number_integer()) {
    out["main_gpu"] = mc["mainGpu"];
  }
  return out;
}

json build_model_load_payload(ConfigStore& config, const std::string& model_id, json body) {
  if (!body.is_object()) body = json::object();
  if (!body.contains("modelId") && !model_id.empty()) body["modelId"] = model_id;
  const json opts = build_engine_load_options(config, model_id);
  if (opts.is_object() && !opts.empty()) {
    if (!body.contains("loadOptions") || !body["loadOptions"].is_object()) {
      body["loadOptions"] = opts;
    } else {
      for (auto it = opts.begin(); it != opts.end(); ++it) {
        if (!body["loadOptions"].contains(it.key())) body["loadOptions"][it.key()] = it.value();
      }
    }
  }
  for (auto it = opts.begin(); it != opts.end(); ++it) {
    if (!body.contains(it.key())) body[it.key()] = it.value();
  }
  return body;
}

namespace {

void push_unique_tier(std::vector<int>& tiers, int value) {
  if (std::find(tiers.begin(), tiers.end(), value) == tiers.end()) tiers.push_back(value);
}

}  // namespace

std::vector<int> model_load_gpu_tiers(ConfigStore& config, const std::string& model_id,
                                       const json& body) {
  int requested = -1;
  if (body.is_object()) {
    if (body.contains("gpu_layers") && body["gpu_layers"].is_number_integer()) {
      requested = body["gpu_layers"].get<int>();
    } else if (body.contains("loadOptions") && body["loadOptions"].is_object() &&
               body["loadOptions"].contains("gpu_layers") &&
               body["loadOptions"]["gpu_layers"].is_number_integer()) {
      requested = body["loadOptions"]["gpu_layers"].get<int>();
    }
  }
  if (requested < 0) {
    const json opts = build_engine_load_options(config, model_id);
    if (opts.contains("gpu_layers") && opts["gpu_layers"].is_number_integer()) {
      requested = opts["gpu_layers"].get<int>();
    }
  }
  if (requested < 0) requested = 999;

  std::vector<int> tiers;
  if (requested <= 0) {
    push_unique_tier(tiers, 0);
    return tiers;
  }
  push_unique_tier(tiers, requested);
  for (const int step : {128, 96, 64, 48, 32, 24, 16, 8}) {
    if (step < requested) push_unique_tier(tiers, step);
  }
  push_unique_tier(tiers, 0);
  return tiers;
}

void apply_gpu_layers_to_load_body(json& body, int gpu_layers) {
  if (!body.is_object()) body = json::object();
  body["gpu_layers"] = gpu_layers;
  if (!body.contains("loadOptions") || !body["loadOptions"].is_object()) {
    body["loadOptions"] = json::object();
  }
  body["loadOptions"]["gpu_layers"] = gpu_layers;
}

bool model_load_engine_died(const std::string& message, bool engine_available) {
  return message.find("process exited") != std::string::npos ||
         message.find("omega-engine unavailable") != std::string::npos ||
         message.find("failed to write to omega-engine") != std::string::npos ||
         message.find("command timed out: model.load") != std::string::npos ||
         message.find("exited during startup") != std::string::npos ||
         !engine_available;
}

bool model_load_error_is_fatal(const std::string& message) {
  return message.find("model not found") != std::string::npos ||
         message.find("modelId required") != std::string::npos ||
         message.find("invalid payload") != std::string::npos ||
         message.find("libomega_infer unavailable") != std::string::npos ||
         message.find("omega_infer.dll missing") != std::string::npos ||
         message.find("omega-engine not found") != std::string::npos;
}

bool model_load_error_may_retry_lower_gpu(const std::string& message) {
  return message.find("out of memory") != std::string::npos ||
         message.find("OutOfMemory") != std::string::npos ||
         message.find("CUDA error") != std::string::npos ||
         message.find("failed to allocate") != std::string::npos ||
         message.find("VRAM") != std::string::npos ||
         message.find("cudaMalloc") != std::string::npos ||
         message.find("ggml") != std::string::npos && message.find("alloc") != std::string::npos;
}

int resolve_context_size(ConfigStore& config, const std::string& model_id) {
  const json mc = resolve_model_settings(config, model_id);
  if (mc.contains("contextSize") && mc["contextSize"].is_number_integer()) {
    return mc["contextSize"].get<int>();
  }
  const json cfg = config.load();
  return cfg.value("contextSize", 8192);
}

int query_loaded_context_size(EngineClient& engine, const std::string& model_id) {
  if (model_id.empty()) return 0;
  try {
    if (!engine.available()) return 0;
    const json loaded = engine.command("model.loaded", json::object(), 5000);
    if (!loaded.contains("contextSizes") || !loaded["contextSizes"].is_object()) return 0;
    int best = 0;
    for (const auto& entry : loaded["contextSizes"].items()) {
      if (!model_keys_match(model_id, entry.key()) || !entry.value().is_number_integer()) continue;
      best = std::max(best, entry.value().get<int>());
    }
    return best;
  } catch (...) {
  }
  return 0;
}

int resolve_effective_context_size(ConfigStore& config, EngineClient& engine,
                                   const std::string& model_id) {
  const int configured = resolve_context_size(config, model_id);
  const int loaded = query_loaded_context_size(engine, model_id);
  if (loaded > 0) return std::min(configured, loaded);
  return configured;
}

void apply_chat_send_load_options(ConfigStore& config, const std::string& model_id, json& payload,
                                 bool simple_prompt) {
  const json opts = build_engine_load_options(config, model_id);
  if (opts.is_object() && !opts.empty()) payload["loadOptions"] = opts;
  if (simple_prompt) payload["promptFormat"] = "simple";
}

void apply_structured_generation_options(ConfigStore& config, const std::string& model_id,
                                         json& payload) {
  const json opts = build_engine_load_options(config, model_id);
  if (opts.is_object() && !opts.empty()) payload["loadOptions"] = opts;
  payload["promptFormat"] = "chat";
  payload["enableThinking"] = false;
}

}  // namespace omega::runtime
