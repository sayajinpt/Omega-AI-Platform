#include "omega/runtime/util/context_trim.hpp"

#include <algorithm>
#include <vector>
#include <regex>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr const char* k_trunc_suffix = "\n\n[… truncated for context limit]";

int template_overhead_tokens(bool agent_mode) {
  return chat_template_overhead_tokens(agent_mode);
}

int generation_reserve_for_trim(int context_size_tokens) {
  // When trimming prompts, leave at least this much room for decode (not a hard output cap).
  const int ctx = std::max(512, context_size_tokens);
  return std::clamp(ctx / 8, 256, ctx / 2);
}

std::string truncate_content(const std::string& content, int max_chars) {
  if (static_cast<int>(content.size()) <= max_chars) return content;
  const int room = std::max(0, max_chars - static_cast<int>(std::string(k_trunc_suffix).size()));
  return content.substr(0, static_cast<size_t>(room)) + k_trunc_suffix;
}

int last_user_index(const std::vector<json>& rest) {
  for (int i = static_cast<int>(rest.size()) - 1; i >= 0; --i) {
    if (rest[static_cast<size_t>(i)].value("role", "") == "user") return i;
  }
  return -1;
}

std::string strip_fenced_code_for_context(std::string content) {
  static const std::regex fence_re(R"(```[\s\S]*?```)", std::regex_constants::icase);
  content = std::regex_replace(content, fence_re, "[code omitted]");
  static const std::regex open_fence_re(R"pat(```[\s\S]*$)pat", std::regex_constants::icase);
  content = std::regex_replace(content, open_fence_re, "[code omitted]");
  return content;
}

std::string compact_tool_results_user_line(std::string content) {
  constexpr const char* k_prefix = "Tool results:";
  if (content.rfind(k_prefix, 0) != 0) return content;
  if (content.size() <= 12000) return content;
  return std::string(k_prefix) + "\n" + content.substr(0, 12000) +
         "\n\n[… tool output truncated for context …]";
}

json slim_message_for_inference(const json& m) {
  if (!m.is_object()) return m;
  json copy = m;
  copy.erase("parts");
  copy.erase("reasoningContent");
  copy.erase("reasoningOpen");
  copy.erase("attachments");
  copy.erase("imagePaths");
  copy.erase("images");
  std::string content = copy.value("content", "");
  const std::string role = copy.value("role", "");
  if (role == "assistant") {
    content = strip_fenced_code_for_context(std::move(content));
    if (content.size() > 8000) content = truncate_content(content, 8000);
  } else if (role == "user") {
    content = compact_tool_results_user_line(std::move(content));
    if (content.size() > 12000) content = truncate_content(content, 12000);
  }
  copy["content"] = content;
  return copy;
}

json trim_agent_messages(const json& messages, int context_size_tokens) {
  const int ctx = std::max(512, context_size_tokens);
  const int overhead = template_overhead_tokens(true);
  const int gen_reserve = generation_reserve_for_trim(ctx);
  const int prompt_budget = std::max(256, ctx - overhead - gen_reserve);

  std::vector<json> system;
  std::vector<json> rest;
  for (const auto& m : messages) {
    if (m.value("role", "") == "system") system.push_back(m);
    else rest.push_back(slim_message_for_inference(m));
  }

  int rest_tokens = 0;
  for (const auto& m : rest) rest_tokens += estimate_tokens(m.value("content", ""));

  int sys_budget = std::max(200, prompt_budget - rest_tokens);
  json out = json::array();
  int used = 0;
  for (const auto& m : system) {
    const int t = estimate_tokens(m.value("content", ""));
    const int remaining = sys_budget - used;
    if (remaining <= 0) break;
    if (t <= remaining) {
      out.push_back(m);
      used += t;
    } else {
      json copy = m;
      copy["content"] = truncate_content(m.value("content", ""), remaining * 4);
      out.push_back(copy);
      break;
    }
  }
  for (const auto& m : rest) out.push_back(m);
  return out;
}

}  // namespace

int chat_template_overhead_tokens(bool agent_mode) {
  return agent_mode ? 256 : 128;
}

int compute_generation_max_tokens(int context_size_tokens, int prompt_tokens_est,
                                  int requested_max_tokens) {
  const int ctx = std::max(512, context_size_tokens);
  const int prompt = std::max(0, prompt_tokens_est);
  const int overhead = chat_template_overhead_tokens(true);
  int headroom = ctx - prompt - overhead;
  headroom = std::max(128, headroom);
  if (requested_max_tokens > 0) return std::min(requested_max_tokens, headroom);
  return headroom;
}

int estimate_tokens(const std::string& content) {
  if (content.empty()) return 0;
  return std::max(1, static_cast<int>(content.size()) / 4);
}

json trim_messages_for_inference(const json& messages, int context_size_tokens, bool agent_mode) {
  const int ctx = std::max(512, context_size_tokens);
  if (!messages.is_array() || messages.empty()) return messages;

  if (agent_mode) return trim_agent_messages(messages, ctx);

  const int overhead = template_overhead_tokens(false);
  const int gen_reserve = generation_reserve_for_trim(ctx);
  const int prompt_budget = std::max(256, ctx - overhead - gen_reserve);

  std::vector<json> system;
  std::vector<json> rest;
  for (const auto& m : messages) {
    if (m.value("role", "") == "system") system.push_back(m);
    else rest.push_back(m);
  }

  int used = 0;
  std::vector<json> kept_system;
  const int sys_cap = std::min(prompt_budget / 2, prompt_budget);
  for (const auto& m : system) {
    const int t = estimate_tokens(m.value("content", ""));
    const int remaining = sys_cap - used;
    if (remaining <= 0) break;
    if (t <= remaining) {
      kept_system.push_back(m);
      used += t;
    } else {
      json copy = m;
      copy["content"] = truncate_content(m.value("content", ""), remaining * 4);
      kept_system.push_back(copy);
      used = sys_cap;
      break;
    }
  }

  if (rest.empty()) {
    json out = json::array();
    for (const auto& m : kept_system) out.push_back(m);
    return out;
  }

  const int user_idx = last_user_index(rest);
  const size_t tail_start = user_idx >= 0 ? static_cast<size_t>(user_idx) : rest.size() - 1;
  std::vector<json> tail(rest.begin() + static_cast<std::ptrdiff_t>(tail_start), rest.end());
  std::vector<json> head(rest.begin(), rest.begin() + static_cast<std::ptrdiff_t>(tail_start));

  for (const auto& m : tail) used += estimate_tokens(m.value("content", ""));

  std::vector<json> kept_head;
  for (int i = static_cast<int>(head.size()) - 1; i >= 0; --i) {
    const int t = estimate_tokens(head[static_cast<size_t>(i)].value("content", ""));
    if (used + t > prompt_budget) break;
    used += t;
    kept_head.insert(kept_head.begin(), head[static_cast<size_t>(i)]);
  }

  std::vector<json> tail_out = tail;
  if (used > prompt_budget && !tail.empty()) {
    json last = tail.back();
    const int last_tokens = estimate_tokens(last.value("content", ""));
    const int room = std::max(120, prompt_budget - (used - last_tokens));
    last["content"] = truncate_content(last.value("content", ""), room * 4);
    tail_out.pop_back();
    tail_out.push_back(last);
  }

  json out = json::array();
  for (const auto& m : kept_system) out.push_back(m);
  for (const auto& m : kept_head) out.push_back(m);
  for (const auto& m : tail_out) out.push_back(m);
  return out;
}

json compact_messages_for_agent_inference(const json& messages) {
  if (!messages.is_array() || messages.empty()) return messages;
  std::vector<json> slim;
  slim.reserve(messages.size());
  for (const auto& m : messages) slim.push_back(slim_message_for_inference(m));

  constexpr size_t k_max_messages = 12;
  if (slim.size() > k_max_messages) {
    slim.erase(slim.begin(), slim.end() - static_cast<std::ptrdiff_t>(k_max_messages));
  }
  json out = json::array();
  for (const auto& m : slim) out.push_back(m);
  return out;
}

int count_user_messages_in_array(const json& messages) {
  if (!messages.is_array()) return 0;
  int n = 0;
  for (const auto& m : messages) {
    if (m.value("role", "") == "user") ++n;
  }
  return n;
}

json last_user_message_only(const json& messages) {
  if (!messages.is_array() || messages.empty()) return json::array();
  for (int i = static_cast<int>(messages.size()) - 1; i >= 0; --i) {
    if (messages[static_cast<size_t>(i)].value("role", "") != "user") continue;
    json out = json::array();
    out.push_back(slim_message_for_inference(messages[static_cast<size_t>(i)]));
    return out;
  }
  return json::array();
}

}  // namespace omega::runtime
