#pragma once

#include "omega/runtime/engine_client.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** OpenAI-compatible remote provider HTTP chat + model listing. */
nlohmann::json remote_chat(const nlohmann::json& provider, const std::string& model,
                           const nlohmann::json& payload, ChatTokenCallback on_token,
                           ChatMetricsCallback on_metrics = {}, int timeout_ms = 600000);

nlohmann::json remote_list_models(const nlohmann::json& provider);

/** Bundled/local Ollama chat (model id may include ollama: prefix). */
nlohmann::json ollama_chat(const std::string& model_id, const nlohmann::json& payload,
                           ChatTokenCallback on_token, ChatMetricsCallback on_metrics = {},
                           int timeout_ms = 600000,
                           const std::string& base_url = "http://127.0.0.1:11434");

/** Sidecar ONNX GenAI / EXL2 chat (OpenAI-compatible sidecar server). */
nlohmann::json sidecar_chat(const nlohmann::json& payload, ChatTokenCallback on_token,
                            ChatMetricsCallback on_metrics = {}, int timeout_ms = 600000,
                            const std::string& base_url = "http://127.0.0.1:0");

}  // namespace omega::runtime
