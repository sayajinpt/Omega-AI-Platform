#include "omega/runtime/agent/parse_tool_calls.hpp"

#include "omega/runtime/orchestrator/tool_catalog.hpp"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <functional>
#include <optional>
#include <set>
#include <nlohmann/json.hpp>
#include <regex>

using json = nlohmann::json;

namespace omega::runtime {

namespace detail {

struct ToolCallMatch {
  size_t start = 0;
  size_t end = 0;
  ToolCall call;
};

std::string trim_copy(std::string s) {
  auto not_space = [](unsigned char c) { return !std::isspace(c); };
  s.erase(s.begin(), std::find_if(s.begin(), s.end(), not_space));
  s.erase(std::find_if(s.rbegin(), s.rend(), not_space).base(), s.end());
  return s;
}

std::string dedup_tool_name(std::string name) {
  if (name.size() >= 6 && name.size() % 2 == 0) {
    const size_t half = name.size() / 2;
    if (name.substr(0, half) == name.substr(half)) return name.substr(0, half);
  }
  return name;
}

ToolCall normalize_call(ToolCall call) {
  call.name = normalize_orchestrator_tool_name(dedup_tool_name(std::move(call.name)));
  return call;
}

std::map<std::string, std::string> json_args_to_map(const json& args) {
  std::map<std::string, std::string> out;
  if (!args.is_object()) return out;
  for (auto it = args.begin(); it != args.end(); ++it) {
    if (it.value().is_string()) out[it.key()] = it.value().get<std::string>();
    else out[it.key()] = it.value().dump();
  }
  return out;
}

size_t find_matching_brace(const std::string& text, size_t open_pos);

std::optional<ToolCall> try_parse_tool_json(const std::string& raw) {
  const size_t start = raw.find('{');
  if (start == std::string::npos) return std::nullopt;
  const size_t end = find_matching_brace(raw, start);
  if (end == std::string::npos) return std::nullopt;
  try {
    const json parsed = json::parse(raw.substr(start, end - start + 1));
    if (parsed.is_object() && parsed.contains("name") && parsed["name"].is_string()) {
      ToolCall call;
      call.name = parsed["name"].get<std::string>();
      if (parsed.contains("args")) call.args = json_args_to_map(parsed["args"]);
      else if (parsed.contains("arguments")) call.args = json_args_to_map(parsed["arguments"]);
      return normalize_call(std::move(call));
    }
    if (parsed.is_object() && parsed.contains("function") && parsed["function"].is_object()) {
      const json& fn = parsed["function"];
      if (!fn.contains("name") || !fn["name"].is_string()) return std::nullopt;
      ToolCall call;
      call.name = fn["name"].get<std::string>();
      if (fn.contains("arguments")) {
        if (fn["arguments"].is_string()) {
          try {
            call.args = json_args_to_map(json::parse(fn["arguments"].get<std::string>()));
          } catch (...) {
          }
        } else {
          call.args = json_args_to_map(fn["arguments"]);
        }
      }
      return normalize_call(std::move(call));
    }
  } catch (...) {
  }
  return std::nullopt;
}

/** Gemma 4 tool strings use `<|"|>…<|"|>` (see google-gemma-4 jinja format_argument). */
constexpr const char* k_gemma4_quote = "<|\"|>";
constexpr size_t k_gemma4_quote_len = 5;

bool starts_with_literal(const std::string& text, size_t pos, const char* lit) {
  const size_t n = std::strlen(lit);
  return pos + n <= text.size() && text.compare(pos, n, lit) == 0;
}

void skip_gemma4_quoted_string(const std::string& text, size_t& i) {
  if (!starts_with_literal(text, i, k_gemma4_quote)) return;
  i += k_gemma4_quote_len;
  while (i < text.size()) {
    const size_t close = text.find(k_gemma4_quote, i);
    if (close == std::string::npos) {
      i = text.size();
      return;
    }
    i = close + k_gemma4_quote_len;
    return;
  }
}

size_t find_matching_brace(const std::string& text, size_t open_pos) {
  if (open_pos >= text.size() || text[open_pos] != '{') return std::string::npos;
  int depth = 0;
  for (size_t i = open_pos; i < text.size(); ++i) {
    if (starts_with_literal(text, i, k_gemma4_quote)) {
      skip_gemma4_quoted_string(text, i);
      continue;
    }
    const char c = text[i];
    if (c == '"' || c == '\'') {
      const char q = c;
      for (++i; i < text.size(); ++i) {
        if (text[i] == '\\' && i + 1 < text.size()) {
          ++i;
          continue;
        }
        if (text[i] == q) break;
      }
      continue;
    }
    if (c == '{') ++depth;
    else if (c == '}') {
      --depth;
      if (depth == 0) return i;
    }
  }
  return std::string::npos;
}

struct Gemma4ArgCursor {
  const std::string& text;
  size_t pos = 0;

  void skip_ws() {
    while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) ++pos;
  }

  bool consume(char ch) {
    skip_ws();
    if (pos < text.size() && text[pos] == ch) {
      ++pos;
      return true;
    }
    return false;
  }

  std::string read_bare_token(const char* stop_chars) {
    skip_ws();
    const size_t start = pos;
    while (pos < text.size()) {
      const char c = text[pos];
      if (std::strchr(stop_chars, c)) break;
      ++pos;
    }
    return trim_copy(text.substr(start, pos - start));
  }

  std::optional<json> parse_array() {
    if (!consume('[')) return std::nullopt;
    json arr = json::array();
    skip_ws();
    if (consume(']')) return arr;
    while (pos < text.size()) {
      auto item = parse_value();
      if (!item) return std::nullopt;
      arr.push_back(std::move(*item));
      skip_ws();
      if (consume(']')) return arr;
      if (!consume(',')) return std::nullopt;
    }
    return std::nullopt;
  }

  std::optional<json> parse_object() {
    if (!consume('{')) return std::nullopt;
    auto body = parse_dict_body();
    if (!body) return std::nullopt;
    if (!consume('}')) return std::nullopt;
    return body;
  }

  std::optional<json> parse_dict_body() {
    json obj = json::object();
    skip_ws();
    if (pos >= text.size()) return obj;
    while (pos < text.size()) {
      skip_ws();
      std::string key;
      if (starts_with_literal(text, pos, k_gemma4_quote)) {
        pos += k_gemma4_quote_len;
        const size_t close = text.find(k_gemma4_quote, pos);
        if (close == std::string::npos) return std::nullopt;
        key = text.substr(pos, close - pos);
        pos = close + k_gemma4_quote_len;
      } else {
        key = read_bare_token(":,}");
        if (key.empty()) return std::nullopt;
      }
      if (!consume(':')) return std::nullopt;
      auto val = parse_value();
      if (!val) return std::nullopt;
      obj[key] = std::move(*val);
      skip_ws();
      if (pos >= text.size()) break;
      if (!consume(',')) break;
    }
    return obj;
  }

  std::optional<json> parse_value() {
    skip_ws();
    if (pos >= text.size()) return std::nullopt;
    if (starts_with_literal(text, pos, k_gemma4_quote)) {
      pos += k_gemma4_quote_len;
      const size_t close = text.find(k_gemma4_quote, pos);
      if (close == std::string::npos) {
        return json(text.substr(pos));
      }
      const std::string s = text.substr(pos, close - pos);
      pos = close + k_gemma4_quote_len;
      return json(s);
    }
    if (text[pos] == '{') return parse_object();
    if (text[pos] == '[') return parse_array();
    const std::string token = read_bare_token(",}");
    if (token.empty()) return std::nullopt;
    if (token == "true") return json(true);
    if (token == "false") return json(false);
    if (token == "null") return json(nullptr);
    try {
      size_t used = 0;
      const long long iv = std::stoll(token, &used, 10);
      if (used == token.size()) return json(iv);
    } catch (...) {
    }
    try {
      size_t used = 0;
      const double dv = std::stod(token, &used);
      if (used == token.size()) return json(dv);
    } catch (...) {
    }
    return json(token);
  }
};

bool tool_allows_name_only_match(const std::string& name) {
  static const std::set<std::string> k_zero_arg = {
      "list_tools",       "omega_capabilities", "inference_status", "list_models",
      "system_info",      "list_skills",        "media_stop",       "media_status",
      "content_list_projects"};
  return k_zero_arg.count(name) > 0;
}

/** Scan key:value pairs; legacy fallback for simple unquoted Gemma args. */
std::map<std::string, std::string> parse_gemma4_kv_args(const std::string& inner) {
  std::map<std::string, std::string> out;
  size_t i = 0;
  const size_t n = inner.size();
  while (i < n) {
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    if (i >= n) break;
    const size_t key_start = i;
    while (i < n && (std::isalnum(static_cast<unsigned char>(inner[i])) || inner[i] == '_')) ++i;
    std::string key = trim_copy(inner.substr(key_start, i - key_start));
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    if (i >= n || inner[i] != ':' || key.empty()) break;
    ++i;
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    std::string val;
    if (i < n && (inner[i] == '"' || inner[i] == '\'')) {
      const char q = inner[i++];
      const size_t start = i;
      while (i < n) {
        if (inner[i] == '\\' && i + 1 < n) {
          val += inner[i++];
          val += inner[i++];
          continue;
        }
        if (inner[i] == q) break;
        val += inner[i++];
      }
      if (i < n) ++i;
    } else {
      const size_t start = i;
      while (i < n && inner[i] != ',') val += inner[i++];
      val = trim_copy(val);
      (void)start;
    }
    out[key] = val;
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    if (i < n && inner[i] == ',') ++i;
  }
  return out;
}

/** Gemma4: <|tool_call>call:tool_name{key:val,...}<tool_call|> */
std::map<std::string, std::string> parse_gemma4_brace_args(const std::string& inner) {
  if (inner.empty()) return {};
  Gemma4ArgCursor cursor{inner, 0};
  if (auto parsed = cursor.parse_dict_body()) {
    return json_args_to_map(*parsed);
  }
  const auto scanned = parse_gemma4_kv_args(inner);
  if (!scanned.empty()) return scanned;
  std::string body = inner;
  static const std::regex key_re(R"((?:^|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:)");
  body = std::regex_replace(body, key_re, R"pat(,"$1":)pat");
  if (!body.empty() && body[0] == ',') body.erase(0, 1);
  try {
    return json_args_to_map(json::parse("{" + body + "}"));
  } catch (...) {
    return scanned;
  }
}

std::map<std::string, std::string> parse_python_kwargs(const std::string& inner) {
  std::map<std::string, std::string> out;
  size_t i = 0;
  const size_t n = inner.size();
  while (i < n) {
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    if (i >= n) break;
    size_t key_start = i;
    while (i < n && inner[i] != '=' && inner[i] != ',') ++i;
    std::string key = trim_copy(inner.substr(key_start, i - key_start));
    if (i < n && inner[i] == '=') ++i;
    while (i < n && std::isspace(static_cast<unsigned char>(inner[i]))) ++i;
    std::string val;
    if (i < n && (inner[i] == '"' || inner[i] == '\'')) {
      const char q = inner[i++];
      const size_t start = i;
      while (i < n && inner[i] != q) ++i;
      val = inner.substr(start, i - start);
      if (i < n) ++i;
    } else {
      const size_t start = i;
      while (i < n && inner[i] != ',') ++i;
      val = trim_copy(inner.substr(start, i - start));
    }
    if (!key.empty()) out[key] = val;
    if (i < n && inner[i] == ',') ++i;
  }
  return out;
}

std::map<std::string, std::string> parse_qwen_parameters(const std::string& block) {
  std::map<std::string, std::string> out;
  static const std::regex param_re(
      R"(<parameter=([^>\s]+)>\s*([\s\S]*?)\s*</parameter>)",
      std::regex_constants::icase);
  auto begin = std::sregex_iterator(block.begin(), block.end(), param_re);
  auto end = std::sregex_iterator();
  for (auto it = begin; it != end; ++it) {
    out[trim_copy((*it)[1].str())] = trim_copy((*it)[2].str());
  }
  return out;
}

void append_regex_matches(const std::string& text, const std::regex& re,
                          const std::function<ToolCallMatch(const std::smatch&)>& build,
                          std::vector<ToolCallMatch>& out) {
  auto begin = std::sregex_iterator(text.begin(), text.end(), re);
  auto end = std::sregex_iterator();
  for (auto it = begin; it != end; ++it) {
    ToolCallMatch m = build(*it);
    if (!m.call.name.empty()) out.push_back(std::move(m));
  }
}

bool spans_overlap(size_t a0, size_t a1, size_t b0, size_t b1) {
  return a0 < b1 && b0 < a1;
}

std::vector<ToolCall> merge_matches(std::vector<ToolCallMatch> matches) {
  std::sort(matches.begin(), matches.end(), [](const ToolCallMatch& a, const ToolCallMatch& b) {
    if (a.start != b.start) return a.start < b.start;
    return (a.end - a.start) > (b.end - b.start);
  });
  std::vector<ToolCallMatch> kept;
  for (const auto& m : matches) {
    bool overlap = false;
    for (const auto& k : kept) {
      if (spans_overlap(m.start, m.end, k.start, k.end)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) kept.push_back(m);
  }
  std::vector<ToolCall> calls;
  calls.reserve(kept.size());
  for (const auto& m : kept) calls.push_back(m.call);
  return calls;
}

void collect_fenced_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex fence_re(R"(```tool(?:\s+JSON)?\s*\n?([\s\S]*?)```)", std::regex_constants::icase);
  append_regex_matches(
      text, fence_re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        std::string body = trim_copy(m[1].str());
        static const std::regex json_prefix_re(R"(^JSON\s*\n?)", std::regex_constants::icase);
        body = std::regex_replace(body, json_prefix_re, "");
        if (auto parsed = try_parse_tool_json(body)) match.call = *parsed;
        return match;
      },
      out);

  static const std::regex open_fence_re(R"pat(```tool(?:\s+JSON)?\s*\n?([\s\S]*)$)pat",
                                        std::regex_constants::icase);
  std::smatch open_m;
  if (std::regex_search(text, open_m, open_fence_re) && open_m.size() >= 2) {
    const size_t fence_start = static_cast<size_t>(open_m.position(0));
    bool already_closed = false;
    for (const auto& m : out) {
      if (m.start == fence_start) {
        already_closed = true;
        break;
      }
    }
    if (!already_closed) {
      ToolCallMatch match;
      match.start = fence_start;
      match.end = text.size();
      if (auto parsed = try_parse_tool_json(open_m[1].str())) {
        match.call = *parsed;
        out.push_back(std::move(match));
      } else {
        std::string body = trim_copy(open_m[1].str());
        static const std::regex json_prefix_re(R"(^JSON\s*\n?)", std::regex_constants::icase);
        body = std::regex_replace(body, json_prefix_re, "");
        if (auto parsed = try_parse_tool_json(body)) {
          match.call = *parsed;
          out.push_back(std::move(match));
        } else if (!body.empty()) {
          ToolCall call;
          call.name = "write_file";
          call.args = json_args_to_map(json::object());
          match.call = normalize_call(std::move(call));
          out.push_back(std::move(match));
        }
      }
    }
  }
}

void collect_qwen_xml_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex block_re(
      R"(<(?:\|)?tool_call(?:\|)?>\s*<function=([^>\s]+)>([\s\S]*?)</function>\s*</(?:\|)?tool_call(?:\|)?>)",
      std::regex_constants::icase);
  append_regex_matches(
      text, block_re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        match.call.args = parse_qwen_parameters(m[2].str());
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_gemma4_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  const std::string prefix = "<|tool_call>call:";
  const std::string suffix = "<tool_call|>";
  size_t search = 0;
  while (search < text.size()) {
    const size_t start = text.find(prefix, search);
    if (start == std::string::npos) break;
    const size_t name_begin = start + prefix.size();
    const size_t brace = text.find('{', name_begin);
    if (brace == std::string::npos) {
      search = name_begin;
      continue;
    }
    const size_t brace_end = find_matching_brace(text, brace);
    if (brace_end == std::string::npos) {
      search = name_begin;
      continue;
    }
    const size_t suffix_pos = text.find(suffix, brace_end);
    if (suffix_pos == std::string::npos) {
      search = name_begin;
      continue;
    }
    ToolCallMatch match;
    match.start = start;
    match.end = suffix_pos + suffix.size();
    match.call.name = trim_copy(text.substr(name_begin, brace - name_begin));
    match.call.args = parse_gemma4_brace_args(text.substr(brace + 1, brace_end - brace - 1));
    match.call = normalize_call(std::move(match.call));
    if (!match.call.name.empty()) out.push_back(std::move(match));
    search = match.end;
  }
}

/** LongCat / Owl Alpha: <longcat_tool_call>list_tools</longcat_tool_call> or JSON inside. */
void collect_longcat_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex block_re(R"(<longcat_tool_call>([\s\S]*?)</longcat_tool_call>)",
                                   std::regex_constants::icase);
  append_regex_matches(
      text, block_re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        std::string inner = trim_copy(m[1].str());
        if (inner.empty()) return match;
        if (auto parsed = try_parse_tool_json(inner)) {
          match.call = *parsed;
        } else {
          const size_t nl = inner.find('\n');
          if (nl != std::string::npos) {
            match.call.name = trim_copy(inner.substr(0, nl));
            if (auto args = try_parse_tool_json(inner.substr(nl))) {
              match.call.args = args->args;
            }
          } else {
            match.call.name = inner;
          }
          match.call = normalize_call(std::move(match.call));
        }
        return match;
      },
      out);
}

void collect_kimi_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex re(
      R"(<\|(?:redacted_)?tool_call_begin_kimi\|>functions\.([a-zA-Z0-9_]+):\d+<\|(?:redacted_)?tool_call_argument_begin\|>([\s\S]*?)(?:<\|(?:redacted_)?tool_call_end_kimi\|>|$))",
      std::regex_constants::icase);
  append_regex_matches(
      text, re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        if (auto parsed = try_parse_tool_json(m[2].str())) {
          match.call.args = parsed->args;
        }
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_lfm2_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex re(
      R"(<\|tool_call_start\|>\[([a-zA-Z0-9_]+)\(([^)]*)\)\]<\|(?:redacted_)?tool_call_end_kimi\|>)",
      std::regex_constants::icase);
  append_regex_matches(
      text, re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        match.call.args = parse_python_kwargs(m[2].str());
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_functionary_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex re(
      R"pat(>>>\s*([a-zA-Z0-9_]+)\s*\n\s*(\{[\s\S]*?\}))pat",
      std::regex_constants::icase);
  append_regex_matches(
      text, re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        if (auto parsed = try_parse_tool_json(m[2].str())) match.call.args = parsed->args;
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_ministral_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex re(
      R"pat(\[TOOL_CALLS\]\s*([a-zA-Z0-9_]+)\s*\n\s*(\{[\s\S]*?\}))pat",
      std::regex_constants::icase);
  append_regex_matches(
      text, re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        if (auto parsed = try_parse_tool_json(m[2].str())) match.call.args = parsed->args;
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_gigachat_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  static const std::regex re(
      R"pat(function call<\|role_sep\|>\s*(\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}))pat",
      std::regex_constants::icase);
  append_regex_matches(
      text, re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        if (auto parsed = try_parse_tool_json(m[1].str())) match.call = *parsed;
        return match;
      },
      out);
}

void collect_deepseek_dsml_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  // DeepSeek V3.2: <｜DSML｜invoke …> (U+FF5C fullwidth vertical bar, UTF-8 EF BC 9C)
  static const std::string bar = "\xEF\xBC\x9C";
  static const std::string invoke_pat =
      "<" + bar + "DSML" + bar +
      R"pat(invoke\s+name="([a-zA-Z0-9_]+)"[^>]*>([\s\S]*?)</)pat" + bar + "DSML" + bar + "invoke>";
  static const std::string param_pat = "<" + bar + "DSML" + bar +
                                       R"pat(parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)</)pat" + bar +
                                       "DSML" + bar + "parameter>";
  static const std::regex invoke_re(invoke_pat, std::regex_constants::icase);
  static const std::regex param_re(param_pat, std::regex_constants::icase);
  append_regex_matches(
      text, invoke_re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        match.call.name = m[1].str();
        const std::string body = m[2].str();
        auto pbegin = std::sregex_iterator(body.begin(), body.end(), param_re);
        auto pend = std::sregex_iterator();
        for (auto it = pbegin; it != pend; ++it) {
          match.call.args[trim_copy((*it)[1].str())] = trim_copy((*it)[2].str());
        }
        match.call = normalize_call(std::move(match.call));
        return match;
      },
      out);
}

void collect_balanced_json_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] != '{') continue;
    const size_t end = find_matching_brace(text, i);
    if (end == std::string::npos) continue;
    const std::string frag = text.substr(i, end - i + 1);
    if (frag.find("\"name\"") == std::string::npos && frag.find("'name'") == std::string::npos) {
      continue;
    }
    if (auto parsed = try_parse_tool_json(frag)) {
      ToolCallMatch match;
      match.start = i;
      match.end = end + 1;
      match.call = std::move(*parsed);
      if (!match.call.name.empty()) out.push_back(std::move(match));
    }
    i = end;
  }
}

void collect_json_tool_calls(const std::string& text, std::vector<ToolCallMatch>& out) {
  collect_balanced_json_tool_calls(text, out);
  static const std::regex loose_re(R"re(\{\s*"name"\s*:\s*"([a-z][a-z0-9_]{1,63})")re",
                                   std::regex_constants::icase);
  append_regex_matches(
      text, loose_re,
      [&](const std::smatch& m) -> ToolCallMatch {
        ToolCallMatch match;
        match.start = static_cast<size_t>(m.position(0));
        match.end = match.start + m.length(0);
        const std::string frag = text.substr(match.start, std::min<size_t>(800, text.size() - match.start));
        if (auto parsed = try_parse_tool_json(frag)) {
          match.call = *parsed;
        } else {
          match.call.name = m[1].str();
          if (match.call.args.empty() && !tool_allows_name_only_match(match.call.name)) {
            match.call.name.clear();
          }
          match.call = normalize_call(std::move(match.call));
        }
        return match;
      },
      out);
}

void collect_all_tool_call_matches(const std::string& text, std::vector<ToolCallMatch>& out) {
  collect_fenced_tool_calls(text, out);
  collect_qwen_xml_tool_calls(text, out);
  collect_gemma4_tool_calls(text, out);
  collect_longcat_tool_calls(text, out);
  collect_kimi_tool_calls(text, out);
  collect_lfm2_tool_calls(text, out);
  collect_functionary_tool_calls(text, out);
  collect_ministral_tool_calls(text, out);
  collect_gigachat_tool_calls(text, out);
  collect_deepseek_dsml_tool_calls(text, out);
  collect_json_tool_calls(text, out);
}

std::string first_nonempty_arg(const std::map<std::string, std::string>& args,
                               std::initializer_list<const char*> keys) {
  for (const char* key : keys) {
    const auto it = args.find(key);
    if (it != args.end() && !it->second.empty()) return it->second;
  }
  return "";
}

int tool_args_score(const std::map<std::string, std::string>& args) {
  int score = 0;
  for (const auto& [k, v] : args) {
    if (!v.empty()) ++score;
    (void)k;
  }
  return score;
}

std::string extract_largest_code_fence(const std::string& text) {
  static const std::regex fence_re(
      R"(```(?:html|htm|xml|javascript|js|css|python|py|typescript|ts)?\s*\n([\s\S]*?)```)",
      std::regex_constants::icase);
  std::string best;
  for (std::sregex_iterator it(text.begin(), text.end(), fence_re), end; it != end; ++it) {
    if (it->size() < 2) continue;
    const std::string body = (*it)[1].str();
    if (body.size() > best.size()) best = body;
  }
  return best;
}

void merge_arg_if_empty(std::map<std::string, std::string>& args, const std::string& key,
                        const std::string& value) {
  if (value.empty()) return;
  const auto it = args.find(key);
  if (it == args.end() || it->second.empty()) args[key] = value;
}

void repair_write_file_call(ToolCall& call, const std::string& text, const std::string& user_query) {
  if (call.name != "write_file") return;
  merge_arg_if_empty(call.args, "user_message", user_query);

  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] != '{') continue;
    const size_t end = find_matching_brace(text, i);
    if (end == std::string::npos) continue;
    const auto parsed = try_parse_tool_json(text.substr(i, end - i + 1));
    if (!parsed || parsed->name != "write_file") continue;
    for (const auto& [k, v] : parsed->args) merge_arg_if_empty(call.args, k, v);
    i = end;
  }

  static const std::regex path_hint_re(
      R"((?:^|[\s"'{,])(code/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+))", std::regex_constants::icase);
  if (first_nonempty_arg(call.args, {"path", "filePath", "file_path", "filepath", "file",
                                     "filename", "target", "dest", "name"})
          .empty()) {
    std::smatch m;
    if (std::regex_search(text, m, path_hint_re) && m.size() >= 2) {
      merge_arg_if_empty(call.args, "path", m[1].str());
    }
  }

  if (first_nonempty_arg(call.args, {"content", "text", "body", "data", "html", "source", "code",
                                     "contents"})
          .empty()) {
    const std::string fenced = extract_largest_code_fence(text);
    if (!fenced.empty()) {
      merge_arg_if_empty(call.args, "content", fenced);
    }
  }
}

bool write_file_call_is_actionable(const ToolCall& call) {
  const std::string content =
      first_nonempty_arg(call.args, {"content", "text", "body", "data", "html", "source", "code",
                                     "contents"});
  if (content.empty()) return false;
  return true;
}

bool tool_call_is_actionable(const ToolCall& call) {
  if (call.name.empty()) return false;
  if (!orchestrator_tool_name_is_known(call.name)) return false;
  if (call.name == "write_file") return write_file_call_is_actionable(call);
  if (tool_allows_name_only_match(call.name)) return true;
  return tool_args_score(call.args) > 0;
}

bool user_query_implies_youtube_play(const std::string& query) {
  static const std::regex re(
      R"(\b(play|watch|listen|stream)\b.{0,32}\b(youtube|yt)\b|\b(youtube|yt)\b.{0,32}\b(play|watch)\b)",
      std::regex_constants::icase);
  return std::regex_search(query, re);
}

std::string infer_youtube_query(const std::string& user_query) {
  std::string q = trim_copy(user_query);
  static const std::regex strip_head(
      R"(^\s*(please\s+)?(can you\s+)?(play|watch|listen to|stream|put on)\s+)",
      std::regex_constants::icase);
  q = std::regex_replace(q, strip_head, "");
  static const std::regex strip_tail(R"(\s+(on\s+)?(youtube|yt)\s*$)", std::regex_constants::icase);
  q = std::regex_replace(q, strip_tail, "");
  return trim_copy(q);
}

bool user_query_implies_image_create(const std::string& query) {
  static const std::regex re(
      R"(\b(create|make|generate|draw|paint|render|design)\b.{0,40}\b(an?\s+)?(image|picture|photo|illustration|portrait|logo|icon|wallpaper|artwork|drawing)\b)",
      std::regex_constants::icase);
  static const std::regex video_hint(
      R"(\b(video|reel|clip|youtube\s+short|short\s+video)\b)", std::regex_constants::icase);
  if (std::regex_search(query, video_hint)) return false;
  return std::regex_search(query, re);
}

bool user_query_implies_video_create(const std::string& query) {
  if (user_query_implies_image_create(query)) return false;
  static const std::regex re(
      R"(\b(create|make|generate|produce|build|render)\b.{0,48}\b(an?\s+)?(video|reel|clip|short|youtube\s+short|yt\s+short)\b|\b(youtube\s+short|short\s+video|tiktok|instagram\s+reel)\b)",
      std::regex_constants::icase);
  return std::regex_search(query, re);
}

bool user_query_implies_audio_create(const std::string& query) {
  if (user_query_implies_video_create(query)) return false;
  static const std::regex re(
      R"(\b(text[\s-]?to[\s-]?speech|tts|voice[\s-]?over|voiceover|narrat(?:e|ion)|read\s+aloud|synthesize\s+speech|generate\s+audio|produce\s+audio|create\s+audio|make\s+audio|speak\s+this)\b)",
      std::regex_constants::icase);
  static const std::regex speak_re(
      R"(\b(?:say|speak|read)\s+.{3,})",
      std::regex_constants::icase);
  return std::regex_search(query, re) || std::regex_search(query, speak_re);
}

std::optional<int> infer_max_duration_seconds(const std::string& query) {
  static const std::regex sec_re(R"((\d+)\s*(?:s|sec|secs|second|seconds)\b)",
                                 std::regex_constants::icase);
  static const std::regex min_re(R"((\d+)\s*(?:m|min|mins|minute|minutes)\b)",
                                 std::regex_constants::icase);
  std::smatch m;
  if (std::regex_search(query, m, sec_re) && m.size() >= 2) {
    return std::stoi(m[1].str());
  }
  if (std::regex_search(query, m, min_re) && m.size() >= 2) {
    return std::stoi(m[1].str()) * 60;
  }
  return std::nullopt;
}

std::string infer_content_theme(const std::string& user_query) {
  std::string q = trim_copy(user_query);
  static const std::regex strip_head(
      R"(^\s*(please\s+)?(can you\s+)?(create|make|generate|produce|build|render)\s+(?:me\s+)?(?:a|an|the)?\s*)",
      std::regex_constants::icase);
  q = std::regex_replace(q, strip_head, "");
  static const std::regex strip_dur(
      R"(\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b)",
      std::regex_constants::icase);
  q = std::regex_replace(q, strip_dur, " ");
  static const std::regex style_about(R"(\s+(?:in\s+)?(?:the\s+)?style\s+(?:of\s+|about\s+))",
                                      std::regex_constants::icase);
  q = std::regex_replace(q, style_about, " about ");
  return trim_copy(q);
}

std::optional<ToolCall> find_best_known_tool_call_in_text(const std::string& text) {
  std::optional<ToolCall> best;
  int best_score = -1;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] != '{') continue;
    const size_t end = find_matching_brace(text, i);
    if (end == std::string::npos) continue;
    const auto parsed = try_parse_tool_json(text.substr(i, end - i + 1));
    if (!parsed || !orchestrator_tool_name_is_known(parsed->name)) continue;
    const int score = tool_args_score(parsed->args);
    if (score > best_score) {
      best_score = score;
      best = *parsed;
    }
    i = end;
  }
  return best;
}

void repair_placeholder_tool_name(ToolCall& call, const std::string& text,
                                  const std::string& user_query) {
  const bool known = orchestrator_tool_name_is_known(call.name);
  if (!known) {
    if (auto better = find_best_known_tool_call_in_text(text)) {
      if (tool_args_score(better->args) >= tool_args_score(call.args)) call = std::move(*better);
    }
  }
  if (!orchestrator_tool_name_is_known(call.name)) {
    const std::string q =
        first_nonempty_arg(call.args, {"query", "url", "search", "q", "title", "song"});
    if (user_query_implies_youtube_play(user_query) || user_query_implies_youtube_play(q)) {
      call.name = "play_youtube";
      merge_arg_if_empty(call.args, "query", q.empty() ? infer_youtube_query(user_query) : q);
      call = normalize_call(std::move(call));
    }
  }
}

void repair_tool_call(ToolCall& call, const std::string& text, const std::string& user_query) {
  repair_placeholder_tool_name(call, text, user_query);
  repair_write_file_call(call, text, user_query);
}

std::vector<ToolCall> finalize_tool_calls(std::vector<ToolCall> calls, const std::string& text,
                                          const std::string& user_query) {
  std::map<std::string, ToolCall> best_by_name;
  for (auto& call : calls) {
    call = normalize_call(std::move(call));
    if (call.name.empty()) continue;
    repair_tool_call(call, text, user_query);
    const auto it = best_by_name.find(call.name);
    if (it == best_by_name.end() || tool_args_score(call.args) > tool_args_score(it->second.args)) {
      best_by_name[call.name] = std::move(call);
    }
  }

  std::vector<ToolCall> out;
  out.reserve(best_by_name.size());
  for (auto& [name, call] : best_by_name) {
    (void)name;
    if (tool_call_is_actionable(call)) out.push_back(std::move(call));
  }
  return out;
}

}  // namespace detail

std::vector<ToolCall> parse_tool_calls(const std::string& text) {
  std::vector<detail::ToolCallMatch> matches;
  detail::collect_all_tool_call_matches(text, matches);
  return detail::merge_matches(std::move(matches));
}

std::vector<ToolCall> finalize_tool_calls(std::vector<ToolCall> calls, const std::string& text,
                                          const std::string& user_query) {
  return detail::finalize_tool_calls(std::move(calls), text, user_query);
}

std::string extract_raw_html_document(const std::string& text) {
  const auto lower_pos = [&](const char* needle) -> size_t {
    const std::string hay = [&] {
      std::string s = text.substr(0, std::min(text.size(), size_t(4096)));
      for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      return s;
    }();
    const std::string n(needle);
    std::string ln = n;
    for (char& c : ln) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return hay.find(ln);
  };
  size_t start = lower_pos("<!doctype");
  if (start == std::string::npos) start = lower_pos("<html");
  if (start == std::string::npos) return "";
  size_t end = lower_pos("</html>");
  if (end != std::string::npos) end += 7;
  else end = text.size();
  if (end <= start) return "";
  return text.substr(start, end - start);
}

bool user_query_implies_write_file(const std::string& query) {
  static const std::regex re(
      R"((\bwrite\b|\bcreate\b|\bmake\b|\bgenerate\b).{0,40}\b(file|html|game|script|page)\b|\b(single|one)\s+html\b)",
      std::regex_constants::icase);
  return std::regex_search(query, re);
}

std::vector<ToolCall> infer_write_file_from_assistant_text(const std::string& text,
                                                           const std::string& user_query) {
  if (!user_query_implies_write_file(user_query)) return {};
  std::string body = detail::extract_largest_code_fence(text);
  if (body.size() < 48) body = extract_raw_html_document(text);
  if (body.size() < 48) return {};

  ToolCall call;
  call.name = "write_file";
  call.args["content"] = body;
  call.args["user_message"] = user_query;
  return finalize_tool_calls({call}, text, user_query);
}

std::vector<ToolCall> infer_tool_calls_from_user_query(const std::string& user_query) {
  if (detail::user_query_implies_youtube_play(user_query)) {
    ToolCall call;
    call.name = "play_youtube";
    call.args["query"] = detail::infer_youtube_query(user_query);
    return finalize_tool_calls({call}, "", user_query);
  }

  if (detail::user_query_implies_video_create(user_query)) {
    ToolCall call;
    call.name = "content_create_run";
    const std::string theme = detail::infer_content_theme(user_query);
    call.args["theme"] = theme.empty() ? user_query : theme;
    if (const auto sec = detail::infer_max_duration_seconds(user_query)) {
      call.args["max_duration_seconds"] = std::to_string(*sec);
    }
    return finalize_tool_calls({call}, "", user_query);
  }

  if (detail::user_query_implies_audio_create(user_query)) {
    ToolCall call;
    call.name = "audio_generate";
    call.args["user_message"] = user_query;
    return finalize_tool_calls({call}, "", user_query);
  }

  if (detail::user_query_implies_image_create(user_query)) {
    ToolCall call;
    call.name = "image_generate";
    call.args["prompt"] = user_query;
    return finalize_tool_calls({call}, "", user_query);
  }

  static const std::regex list_tools_query(
      R"(\b(list|show|tell|what are|enumerate|name).{0,48}\b(tools|capabilities|functions)\b|\bavailable tools\b|\btools in (?:the )?omega\b)",
      std::regex_constants::icase);
  if (std::regex_search(user_query, list_tools_query)) {
    ToolCall call;
    call.name = "list_tools";
    return finalize_tool_calls({call}, "", user_query);
  }

  static const std::regex needs_context(
      R"((show|display|see|print|what).{0,32}(code|html|file|created|wrote|made)|\b(that|it|same|earlier|previous|before)\b)",
      std::regex_constants::icase);
  if (std::regex_search(user_query, needs_context)) {
    ToolCall call;
    call.name = "chat_read_cache";
    call.args["limit"] = "20";
    return finalize_tool_calls({call}, "", user_query);
  }
  return {};
}

std::string strip_tool_fences(const std::string& text) {
  const auto strip = [](std::string s, const std::regex& re) {
    return std::regex_replace(s, re, "");
  };
  std::string out = text;
  out = strip(out, std::regex(R"(```tool[\s\S]*?```)", std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(```tool[\s\S]*$)pat", std::regex_constants::icase));
  out = strip(out, std::regex(R"(<longcat_tool_call>[\s\S]*?</longcat_tool_call>)",
                              std::regex_constants::icase));
  out = strip(out, std::regex(R"(<(?:\|)?tool_call(?:\|)?>[\s\S]*?</(?:\|)?tool_call(?:\|)?>)",
                              std::regex_constants::icase));
  out = strip(out, std::regex(R"(<\|tool_call>call:[\s\S]*?<tool_call\|>)", std::regex_constants::icase));
  out = strip(out, std::regex(R"(<\|(?:redacted_)?tool_call_begin_kimi\|>[\s\S]*?(?:<\|(?:redacted_)?tool_call_end_kimi\|>|$))",
                              std::regex_constants::icase));
  out = strip(out, std::regex(R"(<\|tool_call_start\|>\[[\s\S]*?\]<\|(?:redacted_)?tool_call_end_kimi\|>)",
                              std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(>>>\s*[a-zA-Z0-9_]+\s*\n\s*\{[\s\S]*?\})pat", std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(\[TOOL_CALLS\][\s\S]*?\})pat", std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(function call<\|role_sep\|>\s*\{[\s\S]*?\})pat", std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(\{\s*"name"\s*:\s*"write_file"[\s\S]*$)pat", std::regex_constants::icase));
  out = strip(out, std::regex(R"pat(<\|tool_call>call:write_file[\s\S]*$)pat", std::regex_constants::icase));
  const std::string bar = "\xEF\xBC\x9C";
  out = strip(out, std::regex("<" + bar + "DSML" + bar +
                              R"pat(function_calls>[\s\S]*?</)pat" + bar + "DSML" + bar + "function_calls>",
                              std::regex_constants::icase));
  out = strip(out, std::regex("<" + bar + "DSML" + bar + R"pat(invoke[\s\S]*?</)pat" + bar + "DSML" + bar +
                              "invoke>",
                              std::regex_constants::icase));
  const auto not_space = [](unsigned char c) { return !std::isspace(c); };
  out.erase(out.begin(), std::find_if(out.begin(), out.end(), not_space));
  out.erase(std::find_if(out.rbegin(), out.rend(), not_space).base(), out.end());
  return out;
}

}  // namespace omega::runtime
