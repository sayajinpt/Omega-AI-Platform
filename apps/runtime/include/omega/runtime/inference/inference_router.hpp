#pragma once

#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/storage/provider_store.hpp"

#include <functional>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

using ChatTokenCallback = std::function<void(const std::string& text, int index)>;

/** Routes chat to engine, Ollama, or remote OpenAI-compatible providers. */
class InferenceRouter {
 public:
  InferenceRouter(EngineClient& engine, ProviderStore& providers);

  nlohmann::json chat(const nlohmann::json& payload, const std::string& session_id,
                      ChatTokenCallback on_token, ChatMetricsCallback on_metrics = {},
                      int timeout_ms = 600000);
  nlohmann::json abort(const std::string& session_id);
  bool is_remote_model(const std::string& model_id) const;
  bool is_ollama_model(const std::string& model_id) const;
  bool is_sidecar_model(const std::string& model_id) const;

 private:
  EngineClient& engine_;
  ProviderStore& providers_;
};

}  // namespace omega::runtime
