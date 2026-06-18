#include "omega/runtime/chat/model_gate.hpp"

#include <algorithm>
#include <cctype>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr const char* k_msg_not_loaded =
    "No chat model is loaded in memory.\n\n"
    "Use **Load** next to the model name in the chat bar (or the Models tab), then send your "
    "message. Omega does not auto-load models when you type or click Content Studio choices.";

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool model_ids_match(const std::string& a, const std::string& b) {
  if (a.empty() || b.empty()) return false;
  if (a == b) return true;
  const auto stem = [](std::string id) {
    const size_t slash = id.find_last_of("/\\");
    if (slash != std::string::npos) id = id.substr(slash + 1);
    const size_t dot = id.rfind('.');
    if (dot != std::string::npos) id = id.substr(0, dot);
    return lower_copy(id);
  };
  return stem(a) == stem(b);
}

}  // namespace

bool requires_explicit_model_load(const std::string& model_id) {
  if (model_id.empty()) return false;
  const std::string id = lower_copy(model_id);
  if (id.rfind("ollama:", 0) == 0) return true;
  if (id.rfind("openai:", 0) == 0 || id.rfind("anthropic:", 0) == 0 ||
      id.rfind("google:", 0) == 0 || id.rfind("groq:", 0) == 0) {
    return false;
  }
  return id.find(".gguf") != std::string::npos || id.find('/') != std::string::npos ||
         id.find('\\') != std::string::npos;
}

bool is_chat_model_loaded(EngineClient& engine, const std::string& model_id) {
  if (model_id.empty()) return false;
  if (!requires_explicit_model_load(model_id)) return true;
  try {
    if (!engine.available()) return false;
    const json loaded = engine.command("model.loaded", json::object(), 5000);
    if (loaded.contains("activeModelId") &&
        model_ids_match(model_id, loaded["activeModelId"].get<std::string>())) {
      return true;
    }
    if (loaded.contains("models") && loaded["models"].is_array()) {
      for (const auto& m : loaded["models"]) {
        const std::string stem = m.is_string() ? m.get<std::string>() : m.value("id", "");
        if (model_ids_match(model_id, stem)) return true;
      }
    }
  } catch (...) {
  }
  return false;
}

ChatGateResult check_chat_gate(EngineClient& engine, const std::string& model_id) {
  if (!requires_explicit_model_load(model_id)) return {true, ""};
  if (is_chat_model_loaded(engine, model_id)) return {true, ""};
  return {false, k_msg_not_loaded};
}

}  // namespace omega::runtime
