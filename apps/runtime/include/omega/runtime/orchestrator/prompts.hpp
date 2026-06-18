#pragma once

#include "omega/runtime/orchestrator/parser.hpp"

#include <nlohmann/json.hpp>

#include <cstddef>
#include <string>
#include <vector>

namespace omega::runtime {

struct OrchestratorContextInput {
  std::string user_input;
  std::string model_id;
  std::string user_addendum;
  std::string soul_text;
  std::string memory_context;
  std::string attachment_context;
  std::string session_id;
  size_t thread_message_count = 0;
  bool orchestrator_active = true;
};

struct OrchestratorContext {
  std::string plan_system;
  std::string execute_system;
  std::string user_addendum;
};

/** User overrides from input pipeline chat_orchestrator.promptOverrides (empty = use built-in). */
struct OrchestratorPromptOverrides {
  std::string plan_instructions;
  std::string context_rules;
  std::string chat_tools;
  std::string agent_tools;
  std::string execute_instructions;
  std::string tool_results_continuation;
  std::vector<std::string> execute_round_instructions;
};

OrchestratorPromptOverrides parse_prompt_overrides(const nlohmann::json& orchestrator_node);

/** Built-in defaults for Input Builder (never written to disk). */
nlohmann::json orchestrator_prompt_defaults_json();

/** PROMPT_1 — plan / reply decision. */
std::string build_plan_prompt(const OrchestratorContextInput& input,
                              const OrchestratorPromptOverrides& overrides = {});

/** PROMPT_2 — execute planned tools (phase 2). execute_round is 0-based after plan. */
std::string build_execute_prompt_for_plan(const OrchestratorPlan& plan,
                                        const OrchestratorContextInput& input,
                                        const OrchestratorPromptOverrides& overrides = {},
                                        int execute_round = 0);

OrchestratorContext build_orchestrator_context(const OrchestratorContextInput& input,
                                               const OrchestratorPromptOverrides& overrides = {});

std::string default_tool_results_continuation();

/** Tool catalog + routing rules for the universal direct agent loop (all model families). */
std::string default_universal_agent_tool_guidance();

/** Shorter tool guidance when model context is small (< 4096 tokens). */
std::string compact_universal_agent_tool_guidance();

}  // namespace omega::runtime
