#include "omega/runtime/inference/chat_usage.hpp"

#include "omega/runtime/util/context_trim.hpp"

using json = nlohmann::json;

namespace omega::runtime {

int estimate_messages_tokens(const json& messages) {
  if (!messages.is_array()) return 0;
  int total = 0;
  for (const auto& m : messages) {
    total += estimate_tokens(m.value("content", ""));
  }
  return total;
}

json normalize_chat_result(const json& data, const json& messages) {
  json out = data;
  int tin = out.value("tokens_in", 0);
  int tout = out.value("tokens_out", 0);
  const std::string text = out.value("text", "");
  if (tin <= 0) tin = estimate_messages_tokens(messages);
  if (tout <= 0 && !text.empty()) tout = estimate_tokens(text);
  out["tokens_in"] = tin;
  out["tokens_out"] = tout > 0 ? tout : (text.empty() ? 0 : 1);
  if (!out.contains("gen_ms")) out["gen_ms"] = 0;
  if (!out.contains("stop_reason")) out["stop_reason"] = "end";
  return out;
}

json make_chat_result(const std::string& text, int64_t gen_ms, int tokens_in, int tokens_out) {
  return json{{"text", text},
              {"tokens_in", tokens_in},
              {"tokens_out", tokens_out},
              {"gen_ms", gen_ms},
              {"stop_reason", "end"}};
}

}  // namespace omega::runtime
