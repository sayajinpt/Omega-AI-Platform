#pragma once

#include "omega/runtime/engine_client.hpp"

#include <optional>
#include <string>

namespace omega::runtime {

struct ChatGateResult {
  bool ok = true;
  std::string message;
};

ChatGateResult check_chat_gate(EngineClient& engine, const std::string& model_id);
bool requires_explicit_model_load(const std::string& model_id);
bool is_chat_model_loaded(EngineClient& engine, const std::string& model_id);

}  // namespace omega::runtime
