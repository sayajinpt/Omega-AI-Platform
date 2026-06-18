#pragma once

#include <map>
#include <string>
#include <vector>

namespace omega::runtime {

struct ToolCall {
  std::string name;
  std::map<std::string, std::string> args;
};

/**
 * Extract tool calls from assistant text across common template families:
 * - Omega ```tool JSON fences
 * - Qwen / Hermes XML: <tool_call><function=name><parameter=k>…
 * - Gemma4: <|tool_call>call:name{args}<tool_call|>
 * - Kimi K2: <|tool_call_begin|>functions.name:N…
 * - LFM2: <|tool_call_start|>[name(kwargs)]…
 * - Functionary: >>>name\n{json}
 * - Ministral: [TOOL_CALLS]name\n{json}
 * - GigaChat V3: function call<|role_sep|>\n{"name":…}
 * - DeepSeek V3.2 DSML: <｜DSML｜invoke name="…">…
 * - Loose JSON {"name":"…","arguments":{…}}
 */
std::vector<ToolCall> parse_tool_calls(const std::string& text);

/**
 * Model-agnostic post-pass: merge duplicate calls, repair args from assistant text
 * (e.g. write_file path/content from ``` fences or balanced JSON), drop incomplete calls.
 */
std::vector<ToolCall> finalize_tool_calls(std::vector<ToolCall> calls, const std::string& text,
                                          const std::string& user_query = "");

/** Remove tool-call markup so only the user-visible reply remains. */
std::string strip_tool_fences(const std::string& text);

/**
 * When the model dumps code/HTML in prose instead of a complete tool call, infer write_file
 * from the largest fenced block or raw HTML (coding requests only).
 */
std::vector<ToolCall> infer_write_file_from_assistant_text(const std::string& text,
                                                           const std::string& user_query);

/** Infer a tool from clear user intent when the model emits a bogus placeholder tool name. */
std::vector<ToolCall> infer_tool_calls_from_user_query(const std::string& user_query);

}  // namespace omega::runtime
