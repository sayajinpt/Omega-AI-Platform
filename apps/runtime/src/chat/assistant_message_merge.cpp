#include "omega/runtime/chat/assistant_message_merge.hpp"

#include <regex>

namespace omega::runtime {

namespace {

std::string trim_copy(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == ' ' || s.back() == '\r')) s.pop_back();
  while (!s.empty() && (s.front() == '\n' || s.front() == ' ' || s.front() == '\r')) s.erase(s.begin());
  return s;
}

bool contains_choices_fence(const std::string& text) {
  return text.find("```choices") != std::string::npos ||
         text.find("``` choices") != std::string::npos;
}

std::vector<std::string> extract_choices_fences(const std::string& text) {
  std::vector<std::string> blocks;
  static const std::regex re(R"(```\s*choices\s*\n([\s\S]*?)```)", std::regex_constants::icase);
  for (std::sregex_iterator it(text.begin(), text.end(), re), end; it != end; ++it) {
    if (it->size() >= 2) {
      blocks.push_back("```choices\n" + (*it)[1].str() + "\n```");
    }
  }
  return blocks;
}

nlohmann::json parse_choices_part(const std::string& fence) {
  static const std::regex re(R"(```\s*choices\s*\n([\s\S]*?)```)", std::regex_constants::icase);
  std::smatch m;
  if (!std::regex_search(fence, m, re) || m.size() < 2) return nlohmann::json();
  try {
    const nlohmann::json obj = nlohmann::json::parse(trim_copy(m[1].str()));
    if (!obj.is_object()) return nlohmann::json();
    nlohmann::json options = nlohmann::json::array();
    const nlohmann::json raw_opts = obj.contains("options") ? obj["options"]
                                    : obj.contains("choices") ? obj["choices"]
                                                                : nlohmann::json::array();
    if (!raw_opts.is_array()) return nlohmann::json();
    for (size_t i = 0; i < raw_opts.size(); ++i) {
      const auto& o = raw_opts[i];
      if (!o.is_object()) continue;
      const std::string label = o.value("label", o.value("text", ""));
      const std::string value = o.value("value", label);
      if (label.empty() && value.empty()) continue;
      options.push_back(nlohmann::json{{"id", o.value("id", "opt-" + std::to_string(i + 1))},
                                       {"label", label.empty() ? value : label},
                                       {"value", value},
                                       {"description", o.value("description", "")}});
    }
    const bool input_textarea = obj.value("inputKind", "") == "textarea";
    const bool allow_custom =
        obj.value("allowCustom", obj.value("allow_custom", input_textarea));
    if (options.empty() && !(allow_custom && input_textarea)) return nlohmann::json();
    nlohmann::json part{{"type", "choices"},
                        {"prompt", obj.value("prompt", "")},
                        {"allowCustom", allow_custom},
                        {"multiSelect", obj.value("multiSelect", obj.value("multi_select", false))},
                        {"options", options},
                        {"status", "pending"}};
    if (input_textarea) part["inputKind"] = "textarea";
    return part;
  } catch (...) {
    return nlohmann::json();
  }
}

void merge_parts(nlohmann::json& parts, const nlohmann::json& incoming) {
  if (!incoming.is_array() || incoming.empty()) return;
  if (!parts.is_array()) parts = nlohmann::json::array();
  for (const auto& p : incoming) {
    if (!p.is_object()) continue;
    if (p.value("type", "") == "choices") {
      const std::string prompt = p.value("prompt", "");
      bool dup = false;
      for (const auto& existing : parts) {
        if (existing.value("type", "") == "choices" &&
            existing.value("prompt", "") == prompt) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
    }
    if (p.value("type", "") == "text") {
      const std::string text = p.value("text", "");
      bool dup = false;
      for (const auto& existing : parts) {
        if (existing.value("type", "") == "text" && existing.value("text", "") == text) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
    }
    if (p.value("type", "") == "youtube") {
      const std::string watch = p.value("watchUrl", "");
      const std::string embed = p.value("embedUrl", "");
      bool replaced = false;
      for (auto& existing : parts) {
        if (existing.value("type", "") != "youtube") continue;
        const std::string ew = existing.value("watchUrl", "");
        const std::string ee = existing.value("embedUrl", "");
        if ((!watch.empty() && ew == watch) || (!embed.empty() && ee == embed) ||
            (watch.empty() && embed.empty() && ew.empty() && ee.empty())) {
          existing = p;
          replaced = true;
          break;
        }
      }
      if (replaced) continue;
    }
    parts.push_back(p);
  }
}

bool parts_contain_code_fence(const nlohmann::json& parts) {
  if (!parts.is_array()) return false;
  for (const auto& p : parts) {
    if (p.value("type", "") != "text") continue;
    const std::string t = p.value("text", "");
    if (t.find("```") != std::string::npos) return true;
  }
  return false;
}

void append_text_part(nlohmann::json& parts, const std::string& text) {
  if (text.empty()) return;
  if (!parts.is_array()) parts = nlohmann::json::array();
  parts.push_back(nlohmann::json{{"type", "text"}, {"text", text}});
}

void append_prose_line(std::string& content, const std::string& line) {
  if (line.empty()) return;
  if (content.find(line) != std::string::npos) return;
  if (!content.empty() && content.back() != '\n') content += "\n\n";
  content += line;
}

std::string dedupe_duplicate_paragraphs(std::string text) {
  if (text.empty()) return text;
  std::vector<std::string> paras;
  std::string cur;
  for (size_t i = 0; i <= text.size(); ++i) {
    const bool at_end = i == text.size();
    if (!at_end && text[i] != '\n') {
      cur += text[i];
      continue;
    }
    if (!at_end && i + 1 < text.size() && text[i] == '\n' && text[i + 1] == '\n') {
      const std::string chunk = trim_copy(cur);
      if (!chunk.empty()) {
        if (paras.empty() || paras.back() != chunk) paras.push_back(chunk);
      }
      cur.clear();
      ++i;
      continue;
    }
    if (at_end) {
      const std::string chunk = trim_copy(cur);
      if (!chunk.empty()) {
        if (paras.empty() || paras.back() != chunk) paras.push_back(chunk);
      }
    }
  }
  if (paras.empty()) return trim_copy(text);
  std::string out;
  for (size_t i = 0; i < paras.size(); ++i) {
    if (i) out += "\n\n";
    out += paras[i];
  }
  return out;
}

void append_tool_status_prose(std::string& content, nlohmann::json& parts, const std::string& line,
                              bool skip_text_part_if_code) {
  if (line.empty()) return;
  append_prose_line(content, line);
  if (skip_text_part_if_code && parts_contain_code_fence(parts)) return;
  append_text_part(parts, line);
}

}  // namespace

AssistantMessagePayload build_assistant_payload(const std::string& prose,
                                                const std::vector<nlohmann::json>& tool_results) {
  AssistantMessagePayload out;
  out.content = prose;
  nlohmann::json parts = nlohmann::json::array();

  for (const auto& tr : tool_results) {
    const std::string tool_name = tr.value("tool", "");
    const bool ok = tr.value("ok", false);

    if (tr.contains("parts") && tr["parts"].is_array()) merge_parts(parts, tr["parts"]);

    const std::string output = tr.value("output", "");
    if (ok && tool_name == "write_file" && !output.empty()) {
      append_tool_status_prose(out.content, parts, output, true);
    }
    if (ok && tool_name == "read_file" && !output.empty()) {
      std::string fenced = output;
      if (fenced.find("```") == std::string::npos) {
        fenced = "```text\n" + output + "\n```";
      }
      append_tool_status_prose(out.content, parts, fenced, true);
    }
    if (ok && (tool_name == "play_youtube" || tool_name == "play_local_media" ||
               tool_name == "run_shell" || tool_name == "run_python" ||
               tool_name == "image_generate" || tool_name == "audio_generate") &&
        !output.empty()) {
      if (tool_name == "play_youtube") {
        bool has_youtube_part = false;
        if (tr.contains("parts") && tr["parts"].is_array()) {
          for (const auto& p : tr["parts"]) {
            if (p.value("type", "") == "youtube") {
              has_youtube_part = true;
              break;
            }
          }
        }
        if (!has_youtube_part) append_prose_line(out.content, output);
      } else {
        append_prose_line(out.content, output);
      }
    }
    if (!ok) {
      const std::string line =
          tool_name.empty() ? output : ("**" + tool_name + " failed:** " + output);
      append_prose_line(out.content, line);
      append_text_part(parts, line);
      continue;
    }

    if (output.empty()) continue;

    for (const auto& fence : extract_choices_fences(output)) {
      const nlohmann::json choice_part = parse_choices_part(fence);
      if (!choice_part.is_null()) merge_parts(parts, nlohmann::json::array({choice_part}));
    }
  }

  if (!contains_choices_fence(out.content)) {
    for (const auto& fence : extract_choices_fences(prose)) {
      const nlohmann::json choice_part = parse_choices_part(fence);
      if (!choice_part.is_null()) merge_parts(parts, nlohmann::json::array({choice_part}));
    }
  }

  if (parts.is_array()) {
    for (const auto& p : parts) {
      if (p.value("type", "") != "choices") continue;
      static const std::regex strip_re(R"(```\s*choices\s*\n[\s\S]*?```)", std::regex_constants::icase);
      out.content = std::regex_replace(out.content, strip_re, "");
      while (!out.content.empty() && (out.content.back() == '\n' || out.content.back() == ' ')) {
        out.content.pop_back();
      }
      break;
    }
  }

  if (parts.is_array() && !parts.empty()) {
    out.extras = nlohmann::json{{"parts", parts}};
  }
  out.content = dedupe_duplicate_paragraphs(out.content);
  return out;
}

}  // namespace omega::runtime
