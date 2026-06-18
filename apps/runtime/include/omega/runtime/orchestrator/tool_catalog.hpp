#pragma once

#include <string>
#include <vector>

namespace omega::runtime {

/** Canonical tool names exposed to the LLM orchestrator (must match ToolRegistry). */
std::vector<std::string> orchestrator_tool_names();

/** Short usage blurb for execute-phase PROMPT_2 tool cards. */
std::string orchestrator_tool_card(const std::string& tool_name);

/** Map hallucinated / legacy names to real tools. Returns input if no alias. */
std::string normalize_orchestrator_tool_name(std::string name);

/** True when name resolves to a built-in orchestrator tool (not a placeholder). */
bool orchestrator_tool_name_is_known(const std::string& name);

}  // namespace omega::runtime
