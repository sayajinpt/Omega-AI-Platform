#include "omega/runtime/orchestrator/prompts.hpp"

#include "omega/runtime/orchestrator/tool_catalog.hpp"

#include <sstream>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string format_chat_tools() {
  std::ostringstream oss;
  oss << "chat_choice_card — dynamic options when parameters are missing\n";
  oss << "chat_read_cache — read prior messages (sessionId, limit)\n";
  oss << "chat_manage — create/list/delete/rename chats\n";
  oss << "chat_list — list recent sessions\n";
  return oss.str();
}

std::string format_agent_tool_groups() {
  std::ostringstream oss;
  oss << "## Images\nimage_generate\n\n";
  oss << "## Speech / audio\naudio_generate — TTS; runtime shows voice cards and text input when script is missing\n\n";
  oss << "## Content Studio (video)\ncontent_create_run, content_run_status, content_list_projects\n\n";
  oss << "## Media\nplay_youtube, play_local_media, search_local_media, media_stop, media_status, audio_generate\n\n";
  oss << "## Web\nweb_search, web_fetch\n\n";
  oss << "## Browser\nbrowser_navigate, browser_snapshot\n\n";
  oss << "## Files & terminal\nread_file, write_file, list_dir, grep_files, glob_files, run_python, "
         "run_shell, run_process\n\n";
  oss << "## Memory\nsearch_memory, add_memory\n\n";
  oss << "## Meta\nlist_tools, omega_capabilities, inference_status, list_models\n\n";
  oss << "There is NO tool named \"generate\" — use image_generate for still images.\n";
  return oss.str();
}

std::string format_context_rules_base() {
  return R"(CONTEXT RULES:
- RULE_1: Simple chat or greetings usually need no tools; answer as Omega.
- RULE_2: Recent turns are in the conversation. Use **chat_read_cache** only when the user refers to something outside that window or the reference is ambiguous (pronouns, "that", "same", "continue", "like before").
- RULE_2b: When USER_ATTACHMENTS lists images, code, or files, use them in planning (vision for images; inlined text is already in USER_INPUT; use read_file for unstaged paths).
- RULE_3: Use chat_choice_card only for parameters you still need. Build options for this specific job (tone, language, voice, song, image style, platform, duration) — never generic menus.
- RULE_3b: Content Studio video → one content_create_run with theme (and max_duration_seconds when the user stated a length). sessionId is auto-injected from the active chat — never ask the user for it, never narrate planning in the visible reply. Never project_id, agent_gpu_mode, briefing_confirmed, __user_resume, or GPU chat_choice_card — runtime owns briefing, script, GPU, and render queue.
- RULE_4: Still image / picture / draw / sunset / photo → image_generate. Speech / TTS / read aloud / voiceover / "say …" → audio_generate (runtime shows voice option cards and text input when the script is missing). Video / reel / episode / "create a … video" → content_create_run immediately when theme is clear (e.g. "10 second highway chase" → theme + max_duration_seconds=10). Do not use chat_choice_card for duration or producer when the user already gave a subject. Runtime asks Content Studio vs direct text-to-video when a video model is installed.
- RULE_5: Play music/video → play_youtube or play_local_media; use chat_choice_card only if the user did not imply a source and you cannot proceed.
- RULE_6: Current facts / news → web_search.
- RULE_7: If unsure which tools exist, plan list_tools or omega_capabilities.
- RULE_8: Coding / scripts / HTML pages / games / "write and test" / "run this code" → write_file with path under code/ (e.g. code/asteroids.html or code/hello.py — no leading slash) and content= full file body, then run_python for scripts. Never claim you wrote or ran code without calling those tools.
- RULE_9: Terminal / shell / ping / ipconfig / "run in terminal" / system commands → run_shell with command= (or run_process for a single executable). Never say you cannot run terminal commands — call the tool; the user approves shell access when needed. Report IPs and output only from tool results.)";
}

std::string format_context_rules(const OrchestratorContextInput& input,
                                 const OrchestratorPromptOverrides& overrides) {
  if (!overrides.context_rules.empty()) return overrides.context_rules;
  std::ostringstream oss;
  oss << format_context_rules_base();
  if (input.thread_message_count > 1) {
    oss << "\n- This thread has " << input.thread_message_count
        << " messages; prefer chat_read_cache when the latest turn alone is insufficient.\n";
  }
  return oss.str();
}

std::string format_plan_instructions(const OrchestratorPromptOverrides& overrides) {
  if (!overrides.plan_instructions.empty()) return overrides.plan_instructions;
  return R"(INSTRUCTION_1: Classify USER_INPUT (chat, task, question, coding, media, content creation, etc.).

INSTRUCTION_2: Identify the goal. Decide if tools are required. List exact tool names from CHAT_TOOLS / AGENT_TOOLS.

INSTRUCTION_3: If no tools are needed, output <omega_turn mode="reply"><response>…</response></omega_turn> as Omega (respect SOUL). Never use mode=reply for media, files, coding, or web tasks — those require tools.

INSTRUCTION_4: If tools are needed, output <omega_turn mode="plan"><briefing>one sentence job summary</briefing><tools>comma-separated exact tool names</tools></omega_turn>. Do not invent tool names.

INSTRUCTION_5: You may call tools directly in this turn using ```tool JSON {"name","args"} or your model family's native tool-call syntax (all formats are parsed). Plain text never executes tools.)";
}

std::string format_execute_instructions(const OrchestratorPromptOverrides& overrides,
                                        int execute_round) {
  if (execute_round > 0 &&
      static_cast<size_t>(execute_round - 1) < overrides.execute_round_instructions.size()) {
    const std::string& round_text = overrides.execute_round_instructions[static_cast<size_t>(execute_round - 1)];
    if (!round_text.empty()) return round_text;
  }
  if (!overrides.execute_instructions.empty()) return overrides.execute_instructions;
  return R"(INSTRUCTION: Call tools using fenced ```tool blocks with JSON {"name":"tool_name","args":{…}}.
- sessionId is auto-injected from the active chat when omitted — do not ask the user for it.
- For coding tasks: write_file with path + content (e.g. code/asteroids.html), then run_python for scripts; show results from tool output only.
- For terminal/shell tasks: run_shell with command= (e.g. ping google.com -n 1 on Windows); show IPs and output from tool results only.
- After chat_choice_card or content_create_run, stop and wait for the user — do not call other tools in the same turn.
- content_create_run: pass theme (+ max_duration_seconds when stated). Never pass agent_gpu_mode or briefing flags; never emit ```choices for GPU — the runtime returns those fences.
- When the only planned tool is content_create_run, emit one complete ```tool fence immediately. Do not explain tool rules or sessionId in the visible reply — reasoning belongs in the thinking block only.
- When required parameters are missing, use chat_choice_card with a tailored prompt and options array.
- When the job is complete, reply briefly in plain language (no tool fences).)";
}

}  // namespace

OrchestratorPromptOverrides parse_prompt_overrides(const json& orchestrator_node) {
  OrchestratorPromptOverrides ov;
  if (!orchestrator_node.is_object()) return ov;
  if (!orchestrator_node.contains("promptOverrides") ||
      !orchestrator_node["promptOverrides"].is_object()) {
    return ov;
  }
  const json& po = orchestrator_node["promptOverrides"];
  ov.plan_instructions = po.value("planInstructions", "");
  ov.context_rules = po.value("contextRules", "");
  ov.chat_tools = po.value("chatTools", "");
  ov.agent_tools = po.value("agentTools", "");
  ov.execute_instructions = po.value("executeInstructions", "");
  ov.tool_results_continuation = po.value("toolResultsContinuation", "");
  if (po.contains("executeRounds") && po["executeRounds"].is_array()) {
    for (const auto& row : po["executeRounds"]) {
      if (!row.is_object()) continue;
      ov.execute_round_instructions.push_back(row.value("instructions", ""));
    }
  }
  return ov;
}

json orchestrator_prompt_defaults_json() {
  OrchestratorContextInput dummy;
  return json{{"planInstructions", format_plan_instructions({})},
              {"contextRules", format_context_rules_base()},
              {"chatTools", format_chat_tools()},
              {"agentTools", format_agent_tool_groups()},
              {"executeInstructions", format_execute_instructions({}, 0)},
              {"toolResultsContinuation", default_tool_results_continuation()}};
}

std::string default_tool_results_continuation() {
  return "\nContinue the job using PROMPT_2 instructions. Call more tools if needed, "
         "otherwise answer the user in plain language.";
}

std::string default_universal_agent_tool_guidance() {
  std::ostringstream oss;
  oss << "## Agent tools\n\n" << format_agent_tool_groups();
  oss << format_context_rules_base();
  oss << R"(
## Tool invocation (all model families)
Use a **real tool name** (play_youtube, write_file, run_shell, …) — never placeholders like "tool", "json", or "tool json".
**Recent chat turns are included in the conversation.** Call chat_read_cache(sessionId, limit) only when you need messages outside that window.
Formats the runtime accepts:
- ```tool
{"name":"play_youtube","args":{"query":"metallica"}}
```
- XML / template tokens (Qwen, Gemma, Kimi, DeepSeek, Functionary, etc.)
Do not narrate completed actions in plain text when a tool must run.
After a successful content_create_run or chat_choice_card, stop — the runtime shows choice cards.
)";
  return oss.str();
}

std::string compact_universal_agent_tool_guidance() {
  return R"(## Tools
Answer greetings and simple questions in plain text — no tools required.
When tools are needed, use ```tool JSON {"name":"…","args":{…}}``` or your model's native tool-call syntax.
Common: read_file, write_file, run_python, run_shell, web_search, play_youtube, image_generate, browser_navigate, chat_read_cache.
Recent chat turns are in the message list — call chat_read_cache(sessionId, limit) only for older context.)";
}

std::string build_plan_prompt(const OrchestratorContextInput& input,
                              const OrchestratorPromptOverrides& overrides) {
  const std::string chat_tools =
      overrides.chat_tools.empty() ? format_chat_tools() : overrides.chat_tools;
  const std::string agent_tools =
      overrides.agent_tools.empty() ? format_agent_tool_groups() : overrides.agent_tools;

  std::ostringstream oss;
  oss << "## PROMPT_1 — PLAN\n\n";
  oss << "You are Omega, the resident assistant agent.\n\n";
  oss << format_plan_instructions(overrides) << "\n\n";
  oss << "## CHAT_TOOLS\n" << chat_tools << "\n";
  oss << "## AGENT_TOOLS\n" << agent_tools << "\n";
  oss << format_context_rules(input, overrides) << "\n\n";
  if (!input.soul_text.empty()) oss << "## SOUL\n" << input.soul_text << "\n\n";
  if (!input.memory_context.empty()) oss << "## MEMORY\n" << input.memory_context << "\n\n";
  if (!input.attachment_context.empty()) oss << input.attachment_context << "\n\n";
  if (!input.user_addendum.empty()) oss << input.user_addendum << "\n\n";
  oss << "## USER_INPUT\n\"" << input.user_input << "\"\n";
  return oss.str();
}

std::string build_execute_prompt_for_plan(const OrchestratorPlan& plan,
                                        const OrchestratorContextInput& input,
                                        const OrchestratorPromptOverrides& overrides,
                                        int execute_round) {
  std::ostringstream oss;
  oss << "## PROMPT_2 — EXECUTE\n\n";
  oss << "JOB BRIEFING: " << (plan.briefing.empty() ? "Complete the user request." : plan.briefing)
      << "\n\n";
  oss << "## USER_INPUT\n\"" << input.user_input << "\"\n";
  if (!input.session_id.empty()) {
    oss << "## SESSION\nsessionId=\"" << input.session_id
        << "\" (auto-injected into tool args — you may omit sessionId in ```tool JSON)\n\n";
  }
  oss << "## TOOLS\n";
  for (const auto& raw : plan.tools) {
    const std::string name = normalize_orchestrator_tool_name(raw);
    oss << "### " << name << "\n" << orchestrator_tool_card(name) << "\n\n";
  }
  oss << format_execute_instructions(overrides, execute_round) << "\n\n";
  if (!input.soul_text.empty()) oss << "## SOUL\n" << input.soul_text << "\n\n";
  if (!input.memory_context.empty()) oss << "## MEMORY\n" << input.memory_context << "\n\n";
  if (!input.attachment_context.empty()) oss << input.attachment_context << "\n\n";
  return oss.str();
}

OrchestratorContext build_orchestrator_context(const OrchestratorContextInput& input,
                                               const OrchestratorPromptOverrides& overrides) {
  OrchestratorContext ctx;
  ctx.user_addendum = input.user_addendum;
  ctx.plan_system = build_plan_prompt(input, overrides);
  ctx.execute_system.clear();
  return ctx;
}

}  // namespace omega::runtime
