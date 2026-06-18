#include "omega/runtime/inference/inference_router.hpp"

#include "omega/runtime/inference/chat_usage.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/inference/remote_chat.hpp"
#include "omega/runtime/inference/sidecar_model_inventory.hpp"
#include "omega/runtime/inference/sidecar_supervisor.hpp"
#include "omega/runtime/paths.hpp"

using json = nlohmann::json;

namespace omega::runtime {

InferenceRouter::InferenceRouter(EngineClient& engine, ProviderStore& providers)
    : engine_(engine), providers_(providers) {}

bool InferenceRouter::is_ollama_model(const std::string& model_id) const {
  return model_id.size() > 7 && (model_id.rfind("ollama:", 0) == 0 || model_id.rfind("Ollama:", 0) == 0);
}

bool InferenceRouter::is_remote_model(const std::string& model_id) const {
  return providers_.resolve_model(model_id).has_value();
}

bool InferenceRouter::is_sidecar_model(const std::string& model_id) const {
  return !sidecar_model_directory(models_dir(), model_id).empty();
}

json InferenceRouter::chat(const json& payload, const std::string& session_id,
                           ChatTokenCallback on_token, ChatMetricsCallback on_metrics,
                           int timeout_ms) {
  const std::string model = payload.value("model", "");
  const json messages = payload.contains("messages") ? payload["messages"] : json::array();
  json data;
  if (is_ollama_model(model)) {
    std::string base = OllamaSupervisor::instance().base_url();
    if (const auto route = providers_.resolve_model(model)) {
      base = route->first.value("baseUrl", base);
    }
    data = ollama_chat(model, payload, on_token, on_metrics, timeout_ms, base);
  } else if (is_sidecar_model(model)) {
    if (!SidecarSupervisor::instance().ensure_started()) {
      throw std::runtime_error("Sidecar server unavailable — install ONNX/EXL2 in Settings → Performance");
    }
    const std::string loaded = SidecarSupervisor::instance().loaded_model_id();
    if (loaded.empty() || loaded != model) {
      throw std::runtime_error("Sidecar model not loaded — load " + model + " first");
    }
    data = sidecar_chat(payload, on_token, on_metrics, timeout_ms,
                        SidecarSupervisor::instance().base_url());
  } else if (const auto route = providers_.resolve_model(model)) {
    data = remote_chat(route->first, route->second, payload, on_token, on_metrics, timeout_ms);
  } else {
    data = engine_.chat_send(payload, session_id, on_token, on_metrics, timeout_ms);
  }
  return normalize_chat_result(data, messages);
}

json InferenceRouter::abort(const std::string& session_id) {
  return engine_.chat_abort(session_id);
}

}  // namespace omega::runtime
