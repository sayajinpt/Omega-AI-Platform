#include "omega/runtime/chat/chat_service.hpp"

#include "omega/runtime/chat/message_media.hpp"
#include "omega/runtime/inference/chat_usage.hpp"
#include "omega/runtime/chat/assistant_message_merge.hpp"
#include "omega/runtime/chat/chat_sanitize.hpp"
#include "omega/runtime/services/assistant_prompt.hpp"
#include "omega/runtime/agent/parse_tool_calls.hpp"
#include "omega/runtime/orchestrator/parser.hpp"
#include "omega/runtime/orchestrator/prompts.hpp"
#include "omega/runtime/chat/model_gate.hpp"
#include "omega/runtime/inference/model_load_payload.hpp"
#include "omega/runtime/inference/sidecar_supervisor.hpp"
#include "omega/runtime/util/context_trim.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <regex>
#include <unordered_map>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

json message_obj(const std::string& role, const std::string& content) {
  return json{{"role", role}, {"content", content}};
}

std::string last_user_text(const json& messages) {
  for (int i = static_cast<int>(messages.size()) - 1; i >= 0; --i) {
    if (messages[static_cast<size_t>(i)].value("role", "") == "user") {
      return messages[static_cast<size_t>(i)].value("content", "");
    }
  }
  return "";
}

std::string system_addendum(const json& messages) {
  for (const auto& m : messages) {
    if (m.value("role", "") == "system") return m.value("content", "");
  }
  return "";
}

struct StreamMetricsState {
  std::string model_id;
  std::string backend{"estimated"};
  int context_size{8192};
  int prompt_tokens_est{0};
  int output_tokens_est{0};
  int token_events{0};
  int64_t started_ms{0};
  int64_t first_token_ms{0};
  double measured_prompt_ms{0};
  double measured_gen_ms{0};
  bool measured{false};
};

double json_elapsed_ms(const json& stats, const char* key) {
  if (!stats.contains(key)) return 0.0;
  const json& v = stats[key];
  if (v.is_number_float()) return v.get<double>();
  if (v.is_number_integer()) return static_cast<double>(v.get<int64_t>());
  if (v.is_number_unsigned()) return static_cast<double>(v.get<uint64_t>());
  return 0.0;
}

double token_rate_from_measured(int tokens, double elapsed_ms) {
  if (tokens <= 0 || elapsed_ms <= 0) return 0.0;
  constexpr double kMinElapsedMs = 50.0;
  constexpr double kMaxTokPerSec = 800.0;
  const double rate = tokens * 1000.0 / std::max(elapsed_ms, kMinElapsedMs);
  return std::min(rate, kMaxTokPerSec);
}

int estimate_stream_chunk_tokens(const std::string& text) {
  if (text.empty()) return 0;
  const int by_chars = static_cast<int>((text.size() + 3) / 4);
  return std::clamp(by_chars, 1, 12);
}

std::mutex g_stream_metrics_mu;
std::unordered_map<std::string, StreamMetricsState> g_stream_metrics;

std::string infer_chat_backend(InferenceRouter& router, const std::string& model_id) {
  if (router.is_ollama_model(model_id)) return "ollama";
  if (router.is_sidecar_model(model_id)) return SidecarSupervisor::instance().loaded_format().empty()
                                               ? "sidecar"
                                               : SidecarSupervisor::instance().loaded_format();
  if (router.is_remote_model(model_id)) return "remote";
  return "engine";
}

bool user_query_implies_tool_action(const std::string& query) {
  static const std::regex re(
      R"((play|youtube|watch|create|write|run|script|download|open|search|file|music|video|python|code|browse|navigate|ping|terminal|shell|execute|command|ipconfig|cmd|powershell|generate\s+(an?\s+)?(image|video|picture|photo)))",
      std::regex_constants::icase);
  return std::regex_search(query, re);
}

bool should_retry_agent_without_tools(const std::string& query, int round, int max_rounds,
                                      bool any_tool_results, size_t dialog_messages = 0) {
  constexpr int k_max_silent_tool_retries = 2;
  if (dialog_messages > 8 && round >= 1) return false;
  return user_query_implies_tool_action(query) && !any_tool_results && round + 1 < max_rounds &&
         round < k_max_silent_tool_retries;
}

json agent_step_event(const std::string& id, const std::string& kind, const std::string& title,
                      const std::string& status, int64_t started_at,
                      const std::string& detail = "") {
  json step{{"id", id},
            {"kind", kind},
            {"title", title},
            {"label", title},
            {"status", status},
            {"startedAt", started_at}};
  if (!detail.empty()) step["detail"] = detail;
  return step;
}

constexpr const char* k_tool_retry_user_msg =
    "This request requires native Omega tools. Emit a complete tool call now — ```tool\\n"
    "{\"name\":\"play_youtube\",\"args\":{\"query\":\"...\"}} (use the real tool name, never "
    "\"tool json\"), or your model's native tool-call format. Do not describe completed actions "
    "in plain text; tools must run and return output.";

json replace_last_user_content(json messages, const std::string& content) {
  for (int i = static_cast<int>(messages.size()) - 1; i >= 0; --i) {
    if (messages[static_cast<size_t>(i)].value("role", "") == "user") {
      messages[static_cast<size_t>(i)]["content"] = content;
      break;
    }
  }
  return messages;
}

std::string synthesize_tool_failure_reply(const std::string& tool_blob) {
  std::string reply = "I couldn't complete that request. Tool errors:\n\n" + tool_blob;
  if (tool_blob.find("path is required") != std::string::npos ||
      tool_blob.find("content is required") != std::string::npos) {
    reply +=
        "\nFor write_file, pass both path and content (e.g. path=code/asteroids.html and the full "
        "HTML in content). Use ```tool JSON {\"name\":\"write_file\",\"args\":{\"path\":\"code/"
        "asteroids.html\",\"content\":\"...\"}} when native tool syntax drops arguments.";
  } else if (tool_blob.find("Host filesystem") != std::string::npos ||
             tool_blob.find("outside the session workspace") != std::string::npos) {
    reply +=
        "\nFor files outside the chat project folder, enable **Host filesystem access** in "
        "Settings → Permissions (or approve when prompted), then retry with the absolute path.";
  } else if (tool_blob.find("approval timed out") != std::string::npos ||
             tool_blob.find("Tool approval denied") != std::string::npos ||
             tool_blob.find("Tool approval not granted") != std::string::npos) {
    reply +=
        "\nΩmega was waiting for you to **Approve** or **Deny** the tool in chat (amber card) or "
        "the approval modal. If you did not see a prompt, rebuild with the latest Omega and try "
        "again; the pending prompt should appear while the reply is still generating.";
  }
  return reply;
}

std::string synthesize_terminal_tool_success(const std::vector<json>& tool_results);
std::string empty_model_reply_hint();
bool assistant_payload_is_empty(const AssistantMessagePayload& payload);

std::string synthesize_terminal_tool_success(const std::vector<json>& tool_results) {
  for (auto it = tool_results.rbegin(); it != tool_results.rend(); ++it) {
    if (!it->value("ok", false)) continue;
    const std::string output = it->value("output", "");
    if (output.empty()) continue;
    const std::string name = it->value("tool", "");
    if (name == "write_file" || name == "read_file" || name == "play_youtube" ||
        name == "play_local_media" || name == "run_shell" || name == "run_python" ||
        name == "image_generate" || name == "audio_generate" || name == "browser_navigate" ||
        tool_prose_direct_from_output(name)) {
      return output;
    }
  }
  return "";
}

std::string resolve_assistant_final_text(std::string final_text,
                                         const AssistantMessagePayload& merged,
                                         const std::vector<json>& tool_results) {
  final_text = sanitize_assistant_persist_text(final_text);
  if (!final_text.empty()) return final_text;
  final_text = synthesize_terminal_tool_success(tool_results);
  final_text = sanitize_assistant_persist_text(final_text);
  if (!final_text.empty()) return final_text;
  if (!assistant_payload_is_empty(merged)) return "";
  return empty_model_reply_hint();
}

std::string run_chat_proxy_chain(InputPipelineStore& pipelines, InferenceRouter& router,
                                 const std::string& user_text, const json& sampling,
                                 const std::string& stream_id, int& tokens_in, int& tokens_out) {
  const json pipeline = pipelines.active_for_scope("chat");
  const json resolved = pipelines.resolve_path(pipeline);
  const json proxies = resolved.value("proxyNodes", json::array());
  if (!proxies.is_array() || proxies.empty()) return user_text;

  std::string current = user_text;
  int proxy_idx = 0;
  for (const auto& node : proxies) {
    if (!node.is_object()) continue;
    const std::string proxy_model = node.value("modelId", "");
    if (proxy_model.empty()) continue;

    json proxy_messages = json::array();
    proxy_messages.push_back(message_obj(
        "system",
        "You are a pipeline proxy model (adapter or preprocessor). Transform the user message "
        "for the next chat stage. Output only the transformed text — no markdown fences, labels, "
        "or commentary."));
    proxy_messages.push_back(message_obj("user", current));

    std::string proxy_text;
    const json proxy_result = router.chat(
        json{{"model", proxy_model}, {"messages", proxy_messages}, {"sampling", sampling}},
        stream_id + "-proxy-" + std::to_string(proxy_idx++),
        [&](const std::string& text, int) { proxy_text += text; }, {}, 600000);
    tokens_in += proxy_result.value("tokens_in", 0);
    tokens_out += proxy_result.value("tokens_out", 0);
    if (!proxy_text.empty()) current = proxy_text;
  }
  return current;
}

std::string visible_agent_text_for_user(const std::string& raw) {
  return sanitize_assistant_stream_text(strip_orchestrator_markup(strip_tool_fences(raw)));
}

std::string resolve_visible_assistant_text(std::string final_text, const std::string& round_text) {
  if (!final_text.empty()) return final_text;
  final_text = visible_agent_text_for_user(round_text);
  if (!final_text.empty()) return final_text;
  final_text = sanitize_assistant_stream_text(strip_tool_fences(round_text));
  return final_text;
}

std::string empty_model_reply_hint() {
  return "The model returned no visible text. Try turning off **Agent mode** for a plain chat "
         "reply, reload the model, or use a model with a larger context window.";
}

bool assistant_payload_is_empty(const AssistantMessagePayload& payload) {
  if (!payload.content.empty()) return false;
  if (!payload.extras.is_object() || !payload.extras.contains("parts")) return true;
  const json& parts = payload.extras["parts"];
  return !parts.is_array() || parts.empty();
}

bool output_contains_choices_fence(const std::string& text) {
  return text.find("```choices") != std::string::npos ||
         text.find("``` choices") != std::string::npos;
}

bool tool_result_has_audio_part(const json& tr) {
  if (!tr.contains("parts") || !tr["parts"].is_array()) return false;
  for (const auto& p : tr["parts"]) {
    if (p.value("type", "") == "audio") return true;
  }
  return false;
}

bool agent_tool_round_is_terminal(const std::vector<json>& tool_results) {
  for (const auto& tr : tool_results) {
    if (!tr.value("ok", false)) continue;
    const std::string name = tr.value("tool", "");
    if (name == "write_file" || name == "play_youtube" || name == "play_local_media" ||
        name == "run_shell" || name == "run_python" || name == "image_generate" ||
        name == "read_file" || tool_prose_direct_from_output(name)) {
      return true;
    }
    if (name == "audio_generate" && tool_result_has_audio_part(tr)) return true;
  }
  return false;
}

json make_chat_result_with_parts(const AssistantMessagePayload& payload, int64_t gen_ms,
                                 int tokens_in, int tokens_out) {
  json result = make_chat_result(payload.content, gen_ms, tokens_in, tokens_out);
  if (payload.extras.is_object() && payload.extras.contains("parts")) {
    result["parts"] = payload.extras["parts"];
  }
  return result;
}

json tool_args_with_session(json args, const std::string& session_id,
                            const std::string& last_user_message = "") {
  if (!session_id.empty()) {
    auto session_arg_empty = [&](const char* key) {
      if (!args.contains(key)) return true;
      if (!args[key].is_string()) return false;
      const std::string v = args[key].get<std::string>();
      return v.empty() || v == "null" || v == "undefined";
    };
    if (session_arg_empty("sessionId") && session_arg_empty("session_id")) {
      args["sessionId"] = session_id;
    }
  }
  if (!last_user_message.empty() && !args.contains("user_message") && !args.contains("message")) {
    args["user_message"] = last_user_message;
  }
  return args;
}

bool tool_result_awaits_user_choice(const std::string& tool_name, const json& tr) {
  if (!tr.value("ok", false)) return false;
  if (tool_name == "chat_choice_card") return true;
  // Any successful content_create_run ends the agent tool round — briefing, GPU, or render queued.
  // Prevents the LLM from chaining chat_choice_card GPU + POST in the same turn.
  if (tool_name == "content_create_run") return true;
  if (tool_name == "audio_generate" && output_contains_choices_fence(tr.value("output", ""))) {
    return true;
  }
  return false;
}

void copy_enable_thinking(const json& req, json& payload) {
  if (req.contains("enableThinking")) payload["enableThinking"] = req["enableThinking"];
}

/** Agent rounds always use the model chat template (never "simple" User:/Assistant: labels). */
void apply_agent_prompt_format(const json& /*req*/, json& payload) {
  // The engine "simple" format concatenates User:/Assistant: lines without the model's Jinja
  // template. That works for single-turn agent rounds but breaks multi-turn history (models like
  // Qwen degenerate into numbered fake dialog). enableThinking still controls CoT tags in-template.
  payload["promptFormat"] = "chat";
}

bool request_enable_thinking(const json& req) {
  return req.contains("enableThinking") && req["enableThinking"].is_boolean() &&
         req["enableThinking"].get<bool>();
}

std::vector<ToolCall> safe_parse_tool_calls(const std::string& text) {
  try {
    return parse_tool_calls(text);
  } catch (...) {
    return {};
  }
}

bool assistant_text_looks_like_tool_attempt(const std::string& text) {
  static const std::regex hints(
      R"((```\s*tool\b|<\|tool_call>|<tool_call|<longcat_tool_call|\"write_file\"|\"content_create_run\"|\bwrite_file\b|\bcontent_create_run\b))",
      std::regex_constants::icase);
  return std::regex_search(text, hints);
}

std::vector<ToolCall> parse_agent_tool_calls(const std::string& text, const std::string& user_query) {
  try {
    auto calls = finalize_tool_calls(parse_tool_calls(text), text, user_query);
    if (calls.empty() && user_query_implies_tool_action(user_query)) {
      calls = infer_write_file_from_assistant_text(text, user_query);
    }
    if (calls.empty()) {
      calls = infer_tool_calls_from_user_query(user_query);
    }
    return calls;
  } catch (...) {
    return {};
  }
}

json apply_agent_sampling_defaults(json sampling, int context_tokens, const json& round_messages,
                                   bool agent_mode = true) {
  if (!sampling.is_object()) sampling = json::object();
  const int prompt_est =
      estimate_messages_tokens(round_messages) + chat_template_overhead_tokens(agent_mode);
  const int requested = sampling.value("max_tokens", 0);
  sampling["max_tokens"] =
      compute_generation_max_tokens(context_tokens, prompt_est, requested);
  return sampling;
}

int count_user_turns(const json& dialog) {
  if (!dialog.is_array()) return 0;
  int n = 0;
  for (const auto& m : dialog) {
    if (m.value("role", "") == "user") ++n;
  }
  return n;
}

std::string truncate_tool_blob(std::string blob) {
  if (blob.size() <= 12000) return blob;
  return blob.substr(0, 12000) + "\n\n[… tool output truncated for context …]";
}

void emit_tool_result_assistant_patch(EventBus& events, const std::string& session_id,
                                      const std::vector<json>& tool_results) {
  if (session_id.empty() || tool_results.empty()) return;
  const AssistantMessagePayload payload = build_assistant_payload("", tool_results);
  if (!payload.extras.is_object() || !payload.extras.contains("parts")) return;
  const json& parts = payload.extras["parts"];
  bool has_code_part = false;
  if (parts.is_array()) {
    for (const auto& p : parts) {
      if (p.value("type", "") == "text" &&
          p.value("text", "").find("```") != std::string::npos) {
        has_code_part = true;
        break;
      }
    }
  }
  std::string patch_content;
  if (!has_code_part) patch_content = payload.content;
  json patch{{"sessionId", session_id}, {"parts", parts}};
  if (!patch_content.empty()) patch["content"] = patch_content;
  events.publish("omega:session:assistantPatch", patch);
}

}  // namespace

json ChatService::trim_for_model(const json& messages, const std::string& model_id,
                                 bool agent_mode) const {
  const int ctx = resolve_effective_context_size(config_, engine_, model_id);
  return trim_messages_for_inference(messages, ctx, agent_mode);
}

void ChatService::attach_chat_engine_options(const json& req, const std::string& model_id,
                                             json& payload) const {
  copy_enable_thinking(req, payload);
  apply_chat_send_load_options(config_, model_id, payload, false);
}

ChatService::ChatService(ConfigStore& config, EngineClient& engine, SessionStore& sessions,
                         ToolRegistry& tools, StreamHub& streams, MemoryStore& memory,
                         SoulStore& soul, EventBus& events, InferenceRouter& router,
                         InputPipelineStore& pipelines, ProjectStore& projects, UsageStore& usage)
    : config_(config),
      engine_(engine),
      sessions_(sessions),
      tools_(tools),
      streams_(streams),
      memory_(memory),
      soul_(soul),
      events_(events),
      router_(router),
      pipelines_(pipelines),
      projects_(projects),
      usage_(usage) {}

bool ChatService::llm_orchestrator_enabled() const {
  const json cfg = config_.load();
  return cfg.value("llmOrchestrator", true);
}

bool ChatService::orchestrator_two_phase_enabled() const {
  if (!llm_orchestrator_enabled()) return false;
  const json pipeline = pipelines_.active_for_scope("chat");
  const json resolved = pipelines_.resolve_path(pipeline);
  if (!resolved.value("orchestratorActive", false)) return false;

  const json cfg = config_.load();
  if (cfg.value("llmOrchestratorTwoPhase", false)) return true;

  const json orch_node = resolved.value("orchestratorNode", json::object());
  return orch_node.is_object() && orch_node.value("twoPhaseEnabled", false);
}

std::string ChatService::soul_text() const {
  try {
    const json s = soul_.get();
    return s.value("content", s.value("text", ""));
  } catch (...) {
    return "";
  }
}

std::string ChatService::format_memory_context(const std::string& query) const {
  try {
    const json hits = memory_.search(query, 4);
    if (!hits.is_array() || hits.empty()) return "";
    std::string out;
    for (const auto& h : hits) {
      const std::string line = h.value("content", h.value("text", ""));
      if (!line.empty()) out += "- " + line + "\n";
    }
    return out;
  } catch (...) {
    return "";
  }
}

void ChatService::emit_stream_token(const std::string& stream_id, const std::string& text,
                                    int index) {
  if (text.empty()) return;
  const std::string clean = sanitize_assistant_stream_text(text);
  if (clean.empty()) return;
  {
    std::lock_guard lock(g_stream_metrics_mu);
    auto it = g_stream_metrics.find(stream_id);
    if (it != g_stream_metrics.end()) {
      const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
      if (it->second.first_token_ms == 0) it->second.first_token_ms = now;
      it->second.token_events++;
    }
  }
  emit_stream_metrics(stream_id, "decode");
  streams_.publish(stream_id, "token", json{{"text", clean}, {"index", index}});
  events_.publish("omega:stream:token",
                  json{{"streamId", stream_id}, {"token", json{{"text", clean}, {"index", index}}}});
  events_.publish("omega:agent:token",
                  json{{"streamId", stream_id}, {"text", clean}, {"index", index}});
}

void ChatService::begin_stream_metrics(const std::string& stream_id, const std::string& model_id,
                                       int prompt_tokens_est, const std::string& backend) {
  StreamMetricsState st;
  st.model_id = model_id;
  st.backend = backend;
  st.context_size = resolve_effective_context_size(config_, engine_, model_id);
  st.prompt_tokens_est = prompt_tokens_est;
  st.started_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count();
  {
    std::lock_guard lock(g_stream_metrics_mu);
    g_stream_metrics[stream_id] = std::move(st);
  }
  emit_stream_metrics(stream_id, "prefill");
}

void ChatService::apply_stream_token_counts(const std::string& stream_id, int tokens_in,
                                            int tokens_out) {
  std::lock_guard lock(g_stream_metrics_mu);
  const auto it = g_stream_metrics.find(stream_id);
  if (it == g_stream_metrics.end()) return;
  if (tokens_in > 0) it->second.prompt_tokens_est = tokens_in;
  if (tokens_out > 0) it->second.output_tokens_est = tokens_out;
}

void ChatService::apply_stream_measured_stats(const std::string& stream_id, const json& stats) {
  if (!stats.is_object()) return;
  std::lock_guard lock(g_stream_metrics_mu);
  const auto it = g_stream_metrics.find(stream_id);
  if (it == g_stream_metrics.end()) return;
  StreamMetricsState& st = it->second;
  const int prompt_tokens = stats.value("prompt_tokens", stats.value("tokens_in", 0));
  const int completion_tokens =
      stats.value("completion_tokens", stats.value("tokens_out", 0));
  const double prompt_ms = json_elapsed_ms(stats, "prompt_ms");
  const double gen_ms = json_elapsed_ms(stats, "gen_ms");
  if (prompt_tokens > 0) st.prompt_tokens_est = prompt_tokens;
  if (completion_tokens > 0) st.output_tokens_est = completion_tokens;
  if (prompt_ms > 0) st.measured_prompt_ms = prompt_ms;
  if (gen_ms > 0) st.measured_gen_ms = gen_ms;
  if (stats.value("measured", false) || prompt_ms > 0 || gen_ms > 0 ||
      (prompt_tokens > 0 && (prompt_ms > 0 || gen_ms > 0))) {
    st.measured = true;
  }
}

ChatMetricsCallback ChatService::make_stream_metrics_handler(const std::string& stream_id) {
  return [this, stream_id](const json& stats) {
    apply_stream_measured_stats(stream_id, stats);
    emit_stream_metrics(stream_id, stats.value("phase", "decode"));
  };
}

void ChatService::finalize_stream_measured_stats(const std::string& stream_id, int tokens_in,
                                                 int tokens_out, int64_t prompt_ms,
                                                 int64_t gen_ms) {
  apply_stream_token_counts(stream_id, tokens_in, tokens_out);
  json final_stats{{"measured", true},
                   {"prompt_tokens", tokens_in},
                   {"completion_tokens", tokens_out}};
  if (prompt_ms > 0) final_stats["prompt_ms"] = prompt_ms;
  if (gen_ms > 0) final_stats["gen_ms"] = gen_ms;
  apply_stream_measured_stats(stream_id, final_stats);
  emit_stream_metrics(stream_id, "decode");
}

void ChatService::emit_stream_metrics(const std::string& stream_id, const std::string& phase) {
  StreamMetricsState st;
  {
    std::lock_guard lock(g_stream_metrics_mu);
    const auto it = g_stream_metrics.find(stream_id);
    if (it == g_stream_metrics.end()) return;
    st = it->second;
  }
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();
  double prompt_rate = 0;
  double gen_rate = 0;
  if (st.measured && st.measured_prompt_ms > 0 && st.prompt_tokens_est > 0) {
    prompt_rate = token_rate_from_measured(st.prompt_tokens_est, st.measured_prompt_ms);
  } else if (st.prompt_tokens_est > 0) {
    const int64_t prefill_end = st.first_token_ms > 0 ? st.first_token_ms : now;
    const double prefill_s = std::max(0.25, (prefill_end - st.started_ms) / 1000.0);
    prompt_rate = token_rate_from_measured(st.prompt_tokens_est, prefill_s * 1000.0);
  }
  if (st.measured && st.measured_gen_ms > 0 && st.output_tokens_est > 0) {
    gen_rate = token_rate_from_measured(st.output_tokens_est, st.measured_gen_ms);
  } else if (st.first_token_ms > 0 && st.token_events > 0) {
    const double decode_s = std::max(0.25, (now - st.first_token_ms) / 1000.0);
    gen_rate = token_rate_from_measured(st.token_events, decode_s * 1000.0);
  }
  const int completion_out = st.measured ? st.output_tokens_est : st.token_events;
  json metrics{{"phase", phase},
               {"backend", st.backend},
               {"measured", st.measured},
               {"kvTokens", st.prompt_tokens_est + completion_out},
               {"promptTokens", st.prompt_tokens_est},
               {"completionTokens", completion_out},
               {"contextSize", st.context_size},
               {"promptTokenRate", prompt_rate},
               {"generationTokenRate", gen_rate},
               {"tokenRate", phase == "prefill" ? prompt_rate : gen_rate},
               {"topK", json::array()},
               {"contextAffinity", json::array()},
               {"contextAffinityLabels", json::array()},
               {"measuredAt", now}};
  events_.publish("omega:stream:metrics",
                  json{{"streamId", stream_id}, {"metrics", metrics}});
}

void ChatService::end_stream_metrics(const std::string& stream_id) {
  emit_stream_metrics(stream_id, "idle");
  std::lock_guard lock(g_stream_metrics_mu);
  g_stream_metrics.erase(stream_id);
}

void ChatService::emit_stream_done(const std::string& stream_id, const json& result) {
  end_stream_metrics(stream_id);
  streams_.finish(stream_id, result);
  events_.publish("omega:stream:done", json{{"streamId", stream_id}, {"result", result}});
}

void ChatService::emit_stream_error(const std::string& stream_id, const std::string& error) {
  end_stream_metrics(stream_id);
  streams_.error(stream_id, error);
  events_.publish("omega:stream:error", json{{"streamId", stream_id}, {"error", error}});
}

void ChatService::emit_agent_step(const json& step) {
  events_.publish("omega:agent:step", step);
}

void ChatService::emit_session_message(const std::string& session_id, const std::string& role,
                                       const std::string& content, const json& extras) {
  json message{{"role", role}, {"content", content}};
  if (!extras.is_null() && extras.contains("parts")) message["parts"] = extras["parts"];
  events_.publish("omega:session:messageAppended", json{{"sessionId", session_id}, {"message", message}});
  if (role == "assistant") {
    json patch{{"sessionId", session_id}, {"content", content}};
    if (!extras.is_null() && extras.contains("parts")) patch["parts"] = extras["parts"];
    events_.publish("omega:session:assistantPatch", patch);
  }
}

void ChatService::persist_assistant_message(const std::string& session_id, const std::string& prose,
                                            const std::vector<json>& tool_results) {
  if (session_id.empty()) return;
  const AssistantMessagePayload payload = build_assistant_payload(prose, tool_results);
  if (assistant_payload_is_empty(payload)) return;
  const json extras =
      payload.extras.is_null() || payload.extras.empty() ? json(nullptr) : payload.extras;
  sessions_.append_message(session_id, "assistant", payload.content, extras);
  emit_session_message(session_id, "assistant", payload.content, extras);
}

std::string ChatService::build_agent_system_prompt(const json& dialog,
                                                   const std::string& session_id,
                                                   int context_tokens) const {
  int prior_turns = 0;
  if (!session_id.empty()) {
    const json stored = sessions_.get_messages(session_id);
    prior_turns = std::max(0, count_user_messages_in_array(stored) - 1);
  } else {
    prior_turns = std::max(0, count_user_messages_in_array(dialog) - 1);
  }

  const bool compact_prompt = context_tokens > 0 && context_tokens < 4096;

  std::string prompt;
  if (prior_turns <= 0) {
    prompt = compact_prompt ? "You are Omega, the local desktop assistant.\n"
                            : default_assistant_prompt();
  } else {
    prompt =
        "You are Omega, the local desktop assistant. Recent messages from this session are "
        "included in the conversation below — stay in context, acknowledge prior turns, and "
        "do not greet the user again as if this were a brand-new chat.";
  }
  prompt += compact_prompt ? "\n\n" + compact_universal_agent_tool_guidance()
                           : "\n\n" + default_universal_agent_tool_guidance();
  if (prior_turns > 0) {
    prompt += "\n\n## Thread context\nRecent turns are in the message list. If the user refers "
              "to something outside that window, call **chat_read_cache** with sessionId and a "
              "limit (e.g. 10–20) before acting.\n";
  }

  const json chat_pipeline = pipelines_.active_for_scope("chat");
  const json resolved = pipelines_.resolve_path(chat_pipeline);
  const json orch_node = resolved.value("orchestratorNode", json::object());
  if (orch_node.is_object()) {
    const std::string node_addendum = orch_node.value("systemAddendum", "");
    if (!node_addendum.empty()) {
      prompt += "\n\n## Pipeline notes\n" + node_addendum;
    }
  }
  const json pipeline = resolved.value("pipeline", json::object());
  const json ctx_rules = pipeline.value("contextRules", json::array());
  if (ctx_rules.is_array() && !ctx_rules.empty()) {
    prompt += "\n\n## Custom context rules\n";
    for (const auto& r : ctx_rules) {
      if (r.is_string() && !r.get<std::string>().empty()) {
        prompt += "- " + r.get<std::string>() + "\n";
      }
    }
  }

  const std::string session_notes = system_addendum(dialog);
  if (!session_notes.empty()) {
    prompt += "\n\n## Session preferences\n" + session_notes;
  }
  return prompt;
}

json ChatService::run_simple_chat(const json& req, const std::string& stream_id,
                                  const std::string& session_id) {
  const std::string model = req.value("model", "");
  json messages = req.contains("messages") && req["messages"].is_array() ? req["messages"]
                                                                           : json::array();
  const int prompt_est = estimate_messages_tokens(messages);
  begin_stream_metrics(stream_id, model, prompt_est, infer_chat_backend(router_, model));
  messages = trim_for_model(messages, model, false);
  json sampling = req.contains("sampling") ? req["sampling"] : json::object();
  const int effective_ctx = resolve_effective_context_size(config_, engine_, model);
  sampling = apply_agent_sampling_defaults(sampling, effective_ctx, messages, false);

  json payload{{"model", model}, {"messages", messages}, {"sampling", sampling}};
  if (req.contains("enableThinking")) payload["enableThinking"] = req["enableThinking"];
  const json opts = build_engine_load_options(config_, model);
  if (opts.is_object() && !opts.empty()) payload["loadOptions"] = opts;

  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  int index = 0;
  std::string full;
  {
    std::lock_guard lock(engine_session_mu_);
    active_engine_sessions_[stream_id] = stream_id;
  }
  const ChatMetricsCallback on_metrics = make_stream_metrics_handler(stream_id);
  const json data = router_.chat(
      payload, stream_id,
      [&](const std::string& text, int) {
        full += text;
        emit_stream_token(stream_id, text, index++);
      },
      on_metrics, 600000);
  const std::string text = sanitize_assistant_persist_text(data.value("text", full));
  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  const int tokens_in = data.value("tokens_in", prompt_est);
  const int tokens_out = data.value("tokens_out", 0);
  finalize_stream_measured_stats(stream_id, tokens_in, tokens_out,
                                 data.value("prompt_ms", static_cast<int64_t>(0)),
                                 data.value("gen_ms", static_cast<int64_t>(0)));
  const json result = make_chat_result(text, gen_ms, tokens_in, tokens_out);
  if (!session_id.empty()) {
    persist_assistant_message(session_id, text, {});
    usage_.record(session_id, model, result.value("tokens_in", 0), result.value("tokens_out", 0));
  }
  emit_stream_done(stream_id, result);
  return result;
}

json ChatService::finish_agent_turn(const std::string& stream_id, const std::string& session_id,
                                    const std::string& model, const json& dialog,
                                    const std::vector<json>& tool_results, std::string final_text,
                                    int64_t start_ms, int total_tokens_in, int total_tokens_out) {
  const AssistantMessagePayload merged = build_assistant_payload(final_text, tool_results);
  final_text = resolve_assistant_final_text(final_text, merged, tool_results);
  AssistantMessagePayload out = merged;
  out.content = final_text;
  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start_ms;
  const int tokens_in =
      total_tokens_in > 0 ? total_tokens_in : estimate_messages_tokens(dialog);
  const int tokens_out =
      total_tokens_out > 0 ? total_tokens_out : estimate_tokens(final_text);
  apply_stream_token_counts(stream_id, tokens_in, tokens_out);
  const json result = make_chat_result_with_parts(out, gen_ms, tokens_in, tokens_out);
  if (!session_id.empty()) {
    persist_assistant_message(session_id, final_text, tool_results);
    usage_.record(session_id, model, result.value("tokens_in", 0), result.value("tokens_out", 0));
  }
  if (!final_text.empty()) emit_stream_token(stream_id, final_text, 0);
  emit_stream_done(stream_id, result);
  return result;
}

std::optional<json> ChatService::try_bootstrap_inferred_media_tools(
    const std::string& stream_id, const std::string& session_id, const std::string& model,
    const json& dialog, const std::string& query, int64_t start_ms) {
  if (session_id.empty()) return std::nullopt;
  const auto calls = infer_tool_calls_from_user_query(query);
  if (calls.empty()) return std::nullopt;
  const std::string& primary = calls.front().name;
  if (primary != "content_create_run" && primary != "image_generate" &&
      primary != "audio_generate") {
    return std::nullopt;
  }

  emit_agent_step(agent_step_event(random_uuid(), "tool",
                                   "Inferred " + primary + " from your request", "running",
                                   start_ms));

  std::vector<json> tool_results;
  bool awaiting_user_choice = false;
  for (const auto& call : calls) {
    if (call.name != "content_create_run" && call.name != "image_generate" &&
        call.name != "audio_generate") {
      continue;
    }
    json args = json::object();
    for (const auto& [k, v] : call.args) args[k] = v;
    json tr = tools_.run(call.name, tool_args_with_session(args, session_id, query));
    tr["tool"] = call.name;
    tool_results.push_back(tr);
    if (tool_result_awaits_user_choice(call.name, tr)) {
      awaiting_user_choice = true;
      break;
    }
  }
  if (tool_results.empty()) return std::nullopt;

  emit_agent_step(
      agent_step_event(random_uuid(), "tool", "Inferred tool complete", "done", start_ms));
  emit_tool_result_assistant_patch(events_, session_id, tool_results);

  if (awaiting_user_choice) {
    std::string final_text = tool_results.back().value("output", "");
    if (final_text.empty()) final_text = "Pick an option below or type your answer in chat.";
    return finish_agent_turn(stream_id, session_id, model, dialog, tool_results, final_text,
                             start_ms, 0, 0);
  }
  if (agent_tool_round_is_terminal(tool_results)) {
    const AssistantMessagePayload terminal = build_assistant_payload("", tool_results);
    const std::string final_text =
        resolve_assistant_final_text(terminal.content, terminal, tool_results);
    return finish_agent_turn(stream_id, session_id, model, dialog, tool_results, final_text,
                             start_ms, 0, 0);
  }
  return std::nullopt;
}

json ChatService::run_orchestrator_agent_chat(const json& req, const std::string& stream_id,
                                              const std::string& session_id) {
  const std::string model = req.value("model", "");
  json dialog = req.contains("messages") && req["messages"].is_array() ? req["messages"]
                                                                         : json::array();
  begin_stream_metrics(stream_id, model, estimate_messages_tokens(dialog),
                       infer_chat_backend(router_, model));
  const ChatMetricsCallback on_metrics = make_stream_metrics_handler(stream_id);
  json messages_no_system = json::array();
  for (const auto& m : dialog) {
    if (m.value("role", "") == "system") continue;
    messages_no_system.push_back(m);
  }
  json messages = compact_messages_for_agent_inference(messages_no_system);

  const std::string query = last_user_text(messages);
  std::string user_addendum = system_addendum(dialog);

  const json chat_pipeline = pipelines_.active_for_scope("chat");
  const json resolved_pipeline = pipelines_.resolve_path(chat_pipeline);
  const json orch_node = resolved_pipeline.value("orchestratorNode", json::object());
  const OrchestratorPromptOverrides prompt_ov = parse_prompt_overrides(orch_node);
  if (orch_node.is_object()) {
    const std::string node_addendum = orch_node.value("systemAddendum", "");
    if (!node_addendum.empty()) {
      if (!user_addendum.empty()) user_addendum += "\n\n";
      user_addendum += node_addendum;
    }
  }

  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();

  if (!session_id.empty()) {
    if (auto resumed = tools_.try_resume_content_briefing_choice(session_id, query)) {
      resumed->operator[]("tool") = "content_create_run";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, 0, 0);
    }
    if (auto resumed = tools_.try_resume_content_gpu_choice(session_id, query)) {
      resumed->operator[]("tool") = "content_create_run";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, 0, 0);
    }
    if (auto resumed = tools_.try_resume_tts_choice(session_id, query)) {
      if (!resumed->contains("tool")) resumed->operator[]("tool") = "audio_generate";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, 0, 0);
    }
  }

  if (auto boot = try_bootstrap_inferred_media_tools(stream_id, session_id, model, dialog, query,
                                                     start)) {
    return *boot;
  }

  const bool enable_thinking = request_enable_thinking(req);

  const int prior_turns = [&]() {
    if (session_id.empty()) return 0;
    const json stored = sessions_.get_messages(session_id);
    return std::max(0, count_user_messages_in_array(stored) - 1);
  }();

  OrchestratorContextInput ctx_in{
      query,
      model,
      user_addendum,
      soul_text(),
      format_memory_context(query),
      format_attachment_context_for_prompt(messages, session_id, projects_),
      session_id,
      static_cast<size_t>(prior_turns + 1),
      true};
  const OrchestratorContext orch_ctx = build_orchestrator_context(ctx_in, prompt_ov);

  json sampling = req.contains("sampling") ? req["sampling"] : json::object();
  const int effective_ctx = resolve_effective_context_size(config_, engine_, model);
  const int max_rounds = 8;
  int execute_round_index = 0;
  int token_index = 0;
  int total_tokens_in = 0;
  int total_tokens_out = 0;
  int64_t total_prompt_ms = 0;
  int64_t total_gen_ms = 0;
  std::string final_text;
  std::vector<json> tool_results;

  enum class OrchPhase { Plan, Execute };
  OrchPhase phase = OrchPhase::Plan;
  std::optional<OrchestratorPlan> active_plan;
  std::string active_step_id;
  std::string active_step_kind;
  std::string active_step_title;
  bool streamed_any = false;
  const auto finish_active_step = [&]() {
    if (active_step_id.empty()) return;
    emit_agent_step(agent_step_event(active_step_id, active_step_kind, active_step_title, "done",
                                     start));
    active_step_id.clear();
  };
  const auto start_step = [&](const std::string& kind, const std::string& title) {
    finish_active_step();
    active_step_id = random_uuid();
    active_step_kind = kind;
    active_step_title = title;
    emit_agent_step(
        agent_step_event(active_step_id, kind, title, "running", start));
  };

  for (int round = 0; round < max_rounds; ++round) {
    const bool execute_phase = phase == OrchPhase::Execute && active_plan.has_value();
    const std::string system_content =
        execute_phase ? build_execute_prompt_for_plan(*active_plan, ctx_in, prompt_ov,
                                                      execute_round_index)
                      : orch_ctx.plan_system;
    if (execute_phase) ++execute_round_index;

    json round_messages = json::array();
    round_messages.push_back(message_obj("system", system_content));
    for (const auto& m : messages) round_messages.push_back(m);
    round_messages = trim_for_model(round_messages, model, true);

    json round_sampling = apply_agent_sampling_defaults(sampling, effective_ctx, round_messages);

    const std::string step_label =
        !execute_phase ? "Plan (PROMPT_1)"
                       : "Execute (PROMPT_2) · round " + std::to_string(round);
    start_step(execute_phase ? "execute" : "plan", step_label);

    json payload{{"model", model}, {"messages", round_messages}, {"sampling", round_sampling}};
    apply_agent_prompt_format(req, payload);
    attach_chat_engine_options(req, model, payload);
    std::string round_text;
    int round_stream_idx = 0;
    const std::string engine_sid = stream_id + "-r" + std::to_string(round);
    {
      std::lock_guard lock(engine_session_mu_);
      active_engine_sessions_[stream_id] = engine_sid;
    }
    json round_result;
    try {
      round_result = router_.chat(
          payload, engine_sid,
          [&](const std::string& text, int) { round_text += text; },
          on_metrics, 600000);
    } catch (const std::exception& e) {
      finish_active_step();
      final_text = std::string("The model stopped responding: ") + e.what();
      emit_stream_token(stream_id, final_text, 0);
      break;
    }
    total_tokens_in += round_result.value("tokens_in", 0);
    total_tokens_out += round_result.value("tokens_out", 0);
    total_prompt_ms += round_result.value("prompt_ms", static_cast<int64_t>(0));
    total_gen_ms += round_result.value("gen_ms", static_cast<int64_t>(0));

    if (phase == OrchPhase::Plan) {
      const auto direct_calls = parse_agent_tool_calls(round_text, query);
      if (!direct_calls.empty()) {
        start_step("execute", "Direct tool call (native template syntax)");
        // Fall through — parse_tool_calls supports ```tool, XML, and other family formats.
      } else {
        const OrchestratorPlanParse parsed = parse_plan_phase(round_text);
        if (parsed.ok && parsed.plan.mode == OrchestratorMode::Reply) {
          final_text = visible_reply_from_plan(round_text, parsed.plan);
          if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty())) {
            messages.push_back(message_obj("assistant", final_text));
            messages.push_back(message_obj("user", k_tool_retry_user_msg));
            continue;
          }
          finish_active_step();
          emit_agent_step(
              agent_step_event(random_uuid(), "respond", "Reply to user", "done", start));
          if (!final_text.empty()) emit_stream_token(stream_id, final_text, 0);
          break;
        }
        if (parsed.ok && parsed.plan.mode == OrchestratorMode::Plan && !parsed.plan.tools.empty()) {
          active_plan = parsed.plan;
          phase = OrchPhase::Execute;
          finish_active_step();
          emit_agent_step(
              agent_step_event(random_uuid(), "plan", "Plan complete", "done", start));
          continue;
        }
        final_text = visible_reply_from_plan(round_text, parsed.ok ? parsed.plan : OrchestratorPlan{});
        if (final_text.empty()) {
          final_text = strip_orchestrator_markup(strip_tool_fences(round_text));
        }
        if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty())) {
          messages.push_back(message_obj("assistant", final_text));
          messages.push_back(message_obj("user", k_tool_retry_user_msg));
          continue;
        }
        finish_active_step();
        emit_agent_step(
            agent_step_event(random_uuid(), "respond", "Reply to user", "done", start));
        if (!final_text.empty()) emit_stream_token(stream_id, final_text, 0);
        break;
      }
    }

    auto calls = parse_agent_tool_calls(round_text, query);
    if (calls.empty()) {
      const bool incomplete_tool_attempt =
          assistant_text_looks_like_tool_attempt(round_text) ||
          !safe_parse_tool_calls(round_text).empty();
      if (incomplete_tool_attempt &&
          should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      finish_active_step();
      final_text = resolve_visible_assistant_text(
          sanitize_assistant_stream_text(strip_tool_fences(round_text)), round_text);
      if (!final_text.empty()) {
        emit_stream_token(stream_id, final_text, round_stream_idx++);
        streamed_any = true;
      }
      break;
    }

    start_step("tool", "Run tools");
    std::string tool_blob;
    bool awaiting_user_choice = false;
    bool any_tool_ok = false;
    for (const auto& call : calls) {
      json args = json::object();
      for (const auto& [k, v] : call.args) args[k] = v;
      json tr = tools_.run(call.name, tool_args_with_session(args, session_id, query));
      tr["tool"] = call.name;
      tool_results.push_back(tr);
      if (tr.value("ok", false)) any_tool_ok = true;
      tool_blob += "[" + call.name + "]: " + tr.value("output", "") + "\n\n";
      if (tool_result_awaits_user_choice(call.name, tr)) {
        awaiting_user_choice = true;
        break;
      }
    }
    // Tools (e.g. play_local_media) run while the HTTP stream is still open — clear decode UI.
    emit_stream_metrics(stream_id, "idle");

    if (awaiting_user_choice) {
      finish_active_step();
      const json& tr = tool_results.back();
      if (tr.value("tool", "") == "content_create_run" && tr.value("ok", false)) {
        final_text = tr.value("output", "");
      } else {
        final_text = strip_tool_fences(round_text);
      }
      if (final_text.empty()) {
        final_text = "Pick an option below or type your answer in chat.";
      }
      emit_stream_token(stream_id, final_text, 0);
      break;
    }

    if (!any_tool_ok) {
      if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      finish_active_step();
      final_text = synthesize_tool_failure_reply(tool_blob);
      emit_stream_token(stream_id, final_text, 0);
      break;
    }

    finish_active_step();
    messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
    const std::string tool_continuation = prompt_ov.tool_results_continuation.empty()
                                              ? default_tool_results_continuation()
                                              : prompt_ov.tool_results_continuation;
    messages.push_back(message_obj("user", "Tool results:\n" + tool_blob + tool_continuation));

    emit_tool_result_assistant_patch(events_, session_id, tool_results);
    if (agent_tool_round_is_terminal(tool_results)) {
      const AssistantMessagePayload terminal = build_assistant_payload("", tool_results);
      final_text = resolve_assistant_final_text(terminal.content, terminal, tool_results);
      if (!final_text.empty()) {
        emit_stream_token(stream_id, final_text, token_index++);
        streamed_any = true;
      }
      break;
    }
  }

  finish_active_step();
  if (tool_results.empty() && user_query_implies_tool_action(query)) {
    emit_agent_step(agent_step_event(random_uuid(), "execute", "Universal tool loop (automatic)",
                                     "running", start));
    return run_universal_agent_tool_loop(req, stream_id, session_id, dialog, messages, true);
  }
  const AssistantMessagePayload merged =
      tool_results.empty() ? build_assistant_payload(final_text, tool_results)
                           : build_assistant_payload("", tool_results);
  final_text = resolve_assistant_final_text(
      tool_results.empty() ? merged.content : merged.content, merged, tool_results);
  AssistantMessagePayload out = merged;
  out.content = final_text;
  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  const int tokens_in =
      total_tokens_in > 0 ? total_tokens_in : estimate_messages_tokens(dialog);
  const int tokens_out =
      total_tokens_out > 0 ? total_tokens_out : estimate_tokens(final_text);
  finalize_stream_measured_stats(stream_id, tokens_in, tokens_out, total_prompt_ms, total_gen_ms);
  const json result = make_chat_result_with_parts(out, gen_ms, tokens_in, tokens_out);
  if (!session_id.empty()) {
    persist_assistant_message(session_id, final_text, tool_results);
    usage_.record(session_id, model, result.value("tokens_in", 0), result.value("tokens_out", 0));
  }
  if (!streamed_any && !final_text.empty()) emit_stream_token(stream_id, final_text, 0);
  emit_stream_done(stream_id, result);
  return result;
}

json ChatService::run_agent_chat(const json& req, const std::string& stream_id,
                                 const std::string& session_id) {
  json dialog = req.contains("messages") && req["messages"].is_array() ? req["messages"]
                                                                         : json::array();
  json messages_no_system = json::array();
  for (const auto& m : dialog) {
    if (m.value("role", "") == "system") continue;
    messages_no_system.push_back(m);
  }

  if (orchestrator_two_phase_enabled()) {
    return run_orchestrator_agent_chat(req, stream_id, session_id);
  }
  return run_universal_agent_tool_loop(req, stream_id, session_id, dialog, messages_no_system);
}

json ChatService::run_universal_agent_tool_loop(const json& req, const std::string& stream_id,
                                                const std::string& session_id,
                                                const json& dialog,
                                                const json& messages_no_system,
                                                bool metrics_already_started) {
  const std::string query = last_user_text(messages_no_system);
  const std::string model = req.value("model", "");
  if (!metrics_already_started) {
    begin_stream_metrics(stream_id, model, estimate_messages_tokens(dialog),
                         infer_chat_backend(router_, model));
  }
  const ChatMetricsCallback on_metrics = make_stream_metrics_handler(stream_id);
  json messages = compact_messages_for_agent_inference(messages_no_system);
  json sampling = req.contains("sampling") ? req["sampling"] : json::object();
  const int effective_ctx = resolve_effective_context_size(config_, engine_, model);
  int proxy_tokens_in = 0;
  int proxy_tokens_out = 0;
  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();

  if (!session_id.empty()) {
    if (auto resumed = tools_.try_resume_content_briefing_choice(session_id, query)) {
      resumed->operator[]("tool") = "content_create_run";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, proxy_tokens_in,
                               proxy_tokens_out);
    }
    if (auto resumed = tools_.try_resume_content_gpu_choice(session_id, query)) {
      resumed->operator[]("tool") = "content_create_run";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, proxy_tokens_in,
                               proxy_tokens_out);
    }
    if (auto resumed = tools_.try_resume_tts_choice(session_id, query)) {
      if (!resumed->contains("tool")) resumed->operator[]("tool") = "audio_generate";
      return finish_agent_turn(stream_id, session_id, model, dialog, {*resumed},
                               resumed->value("output", ""), start, proxy_tokens_in,
                               proxy_tokens_out);
    }
  }

  if (auto boot = try_bootstrap_inferred_media_tools(stream_id, session_id, model, dialog, query,
                                                     start)) {
    return *boot;
  }

  const std::string proxied =
      run_chat_proxy_chain(pipelines_, router_, query, sampling, stream_id, proxy_tokens_in,
                           proxy_tokens_out);
  if (proxied != query) {
    messages = replace_last_user_content(messages, proxied);
    emit_agent_step(agent_step_event(random_uuid(), "execute", "Proxy model chain", "done", start,
                                     "Input passed through pipeline proxy model(s)"));
  }
  const int max_rounds = 8;
  int token_index = 0;
  int total_tokens_in = proxy_tokens_in;
  int total_tokens_out = proxy_tokens_out;
  int64_t total_prompt_ms = 0;
  int64_t total_gen_ms = 0;
  std::string final_text;
  std::vector<json> tool_results;
  std::string tool_step_id;
  bool streamed_any = false;

  for (int round = 0; round < max_rounds; ++round) {
    json round_messages = json::array();
    round_messages.push_back(
        message_obj("system", build_agent_system_prompt(dialog, session_id, effective_ctx)));
    for (const auto& m : messages) round_messages.push_back(m);
    round_messages = trim_for_model(round_messages, model, true);

    json round_sampling = apply_agent_sampling_defaults(sampling, effective_ctx, round_messages);
    json payload{{"model", model}, {"messages", round_messages}, {"sampling", round_sampling}};
    apply_agent_prompt_format(req, payload);
    attach_chat_engine_options(req, model, payload);
    std::string round_text;
    int round_stream_idx = 0;
    const std::string engine_sid = stream_id;
    {
      std::lock_guard lock(engine_session_mu_);
      active_engine_sessions_[stream_id] = engine_sid;
    }
    json round_result;
    try {
      round_result = router_.chat(
          payload, engine_sid,
          [&](const std::string& text, int) { round_text += text; },
          on_metrics, 600000);
    } catch (const std::exception& e) {
      final_text = std::string("The model stopped responding: ") + e.what();
      emit_stream_token(stream_id, final_text, 0);
      break;
    }
    total_tokens_in += round_result.value("tokens_in", 0);
    total_tokens_out += round_result.value("tokens_out", 0);
    total_prompt_ms += round_result.value("prompt_ms", static_cast<int64_t>(0));
    total_gen_ms += round_result.value("gen_ms", static_cast<int64_t>(0));

    auto calls = parse_agent_tool_calls(round_text, query);
    if (calls.empty()) {
      const bool incomplete_tool_attempt =
          assistant_text_looks_like_tool_attempt(round_text) ||
          !safe_parse_tool_calls(round_text).empty();
      if (incomplete_tool_attempt &&
          should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty(),
                                           messages.size())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty(),
                                           messages.size())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      final_text = resolve_visible_assistant_text(
          sanitize_assistant_stream_text(strip_tool_fences(round_text)), round_text);
      if (!final_text.empty()) {
        emit_stream_token(stream_id, final_text, token_index++);
        streamed_any = true;
      }
      break;
    }

    tool_step_id = random_uuid();
    emit_agent_step(agent_step_event(tool_step_id, "tool", "Run tools", "running", start));
    std::string tool_blob;
    bool awaiting_user_choice = false;
    bool any_tool_ok = false;
    for (const auto& call : calls) {
      json args = json::object();
      for (const auto& [k, v] : call.args) args[k] = v;
      json tr = tools_.run(call.name, tool_args_with_session(args, session_id, query));
      tr["tool"] = call.name;
      tool_results.push_back(tr);
      if (tr.value("ok", false)) any_tool_ok = true;
      tool_blob += "[" + call.name + "]: " + tr.value("output", "") + "\n\n";
      if (tool_result_awaits_user_choice(call.name, tr)) {
        awaiting_user_choice = true;
        break;
      }
    }
    emit_agent_step(agent_step_event(tool_step_id, "tool", "Run tools", "done", start));
    tool_step_id.clear();
    emit_stream_metrics(stream_id, "idle");

    if (awaiting_user_choice) {
      const json& tr = tool_results.back();
      if (tr.value("tool", "") == "content_create_run" && tr.value("ok", false)) {
        final_text = tr.value("output", "");
      } else {
        final_text = strip_tool_fences(round_text);
      }
      if (final_text.empty()) {
        final_text = "Pick an option below or type your answer in chat.";
      }
      emit_stream_token(stream_id, final_text, 0);
      break;
    }

    if (!any_tool_ok) {
      if (should_retry_agent_without_tools(query, round, max_rounds, !tool_results.empty(),
                                           messages.size())) {
        messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
        messages.push_back(message_obj("user", k_tool_retry_user_msg));
        continue;
      }
      final_text = synthesize_tool_failure_reply(tool_blob);
      emit_stream_token(stream_id, final_text, 0);
      break;
    }

    emit_tool_result_assistant_patch(events_, session_id, tool_results);

    messages.push_back(message_obj("assistant", strip_tool_fences(round_text)));
    messages.push_back(message_obj(
        "user", "Tool results:\n" + truncate_tool_blob(tool_blob) +
                    "\nContinue and answer the user in plain language using only facts from tool "
                    "output above."));

    if (agent_tool_round_is_terminal(tool_results)) {
      const AssistantMessagePayload terminal = build_assistant_payload("", tool_results);
      final_text = resolve_assistant_final_text(terminal.content, terminal, tool_results);
      if (!final_text.empty()) {
        emit_stream_token(stream_id, final_text, token_index++);
        streamed_any = true;
      }
      break;
    }
  }

  const AssistantMessagePayload merged =
      tool_results.empty() ? build_assistant_payload(final_text, tool_results)
                           : build_assistant_payload("", tool_results);
  final_text = resolve_assistant_final_text(
      tool_results.empty() ? merged.content : merged.content, merged, tool_results);
  AssistantMessagePayload out = merged;
  out.content = final_text;
  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  const int tokens_in =
      total_tokens_in > 0 ? total_tokens_in : estimate_messages_tokens(dialog);
  const int tokens_out =
      total_tokens_out > 0 ? total_tokens_out : estimate_tokens(final_text);
  finalize_stream_measured_stats(stream_id, tokens_in, tokens_out, total_prompt_ms, total_gen_ms);
  const json result = make_chat_result_with_parts(out, gen_ms, tokens_in, tokens_out);
  if (!session_id.empty()) {
    persist_assistant_message(session_id, final_text, tool_results);
    usage_.record(session_id, model, result.value("tokens_in", 0), result.value("tokens_out", 0));
  }
  if (!streamed_any && !final_text.empty()) emit_stream_token(stream_id, final_text, 0);
  emit_stream_done(stream_id, result);
  return result;
}

json ChatService::send(const json& req) {
  const std::string stream_id =
      req.value("streamId", req.value("stream_id", random_uuid()));
  const std::string session_id = req.value("sessionId", req.value("session_id", ""));
  const std::string model = req.value("model", "");

  json messages = req.contains("messages") && req["messages"].is_array() ? req["messages"]
                                                                           : json::array();
  const json top_attachments =
      req.contains("attachments") && req["attachments"].is_array() ? req["attachments"]
                                                                   : json::array();
  if (!session_id.empty()) {
    messages = prepare_chat_messages_for_inference(messages, session_id, projects_,
                                                   top_attachments, config_.load());
  }

  json req_work = req;
  req_work["messages"] = messages;

  if (!router_.is_remote_model(model) && !router_.is_ollama_model(model)) {
    const ChatGateResult gate = check_chat_gate(engine_, model);
    if (!gate.ok) {
      const json result = make_chat_result(gate.message, 0);
      emit_stream_token(stream_id, gate.message, 0);
      emit_stream_done(stream_id, result);
      return result;
    }
  }

  if (!session_id.empty()) {
    for (int i = static_cast<int>(messages.size()) - 1; i >= 0; --i) {
      if (messages[static_cast<size_t>(i)].value("role", "") != "user") continue;
      const json& user_msg = messages[static_cast<size_t>(i)];
      const std::string user_text = user_msg.value("content", "");
      if (user_text.empty() && !user_msg.contains("parts")) break;
      const json extras = user_message_persist_extras(user_msg);
      sessions_.append_message(session_id, "user", user_text, extras);
      emit_session_message(session_id, "user", user_text, extras);
      break;
    }
  }

  {
    std::lock_guard lock(abort_mu_);
    abort_flags_[stream_id] = false;
  }

  json result;
  try {
    if (req.value("agentMode", false)) {
      result = run_agent_chat(req_work, stream_id, session_id);
    } else {
      result = run_simple_chat(req_work, stream_id, session_id);
    }
  } catch (const std::exception& e) {
    emit_stream_error(stream_id, e.what());
    {
      std::lock_guard lock(engine_session_mu_);
      active_engine_sessions_.erase(stream_id);
    }
    return make_chat_result(e.what(), 0);
  }
  {
    std::lock_guard lock(engine_session_mu_);
    active_engine_sessions_.erase(stream_id);
  }
  return result;
}

json ChatService::abort(const std::string& stream_id) {
  {
    std::lock_guard lock(abort_mu_);
    abort_flags_[stream_id] = true;
  }
  std::string engine_sid = stream_id;
  {
    std::lock_guard lock(engine_session_mu_);
    const auto it = active_engine_sessions_.find(stream_id);
    if (it != active_engine_sessions_.end()) engine_sid = it->second;
  }
  try {
    router_.abort(engine_sid);
  } catch (...) {
  }
  emit_stream_error(stream_id, "aborted");
  return json{{"aborted", true}};
}

json ChatService::poll_stream(const std::string& stream_id, size_t& cursor) {
  const auto events = streams_.poll(stream_id, cursor, 100);
  json arr = json::array();
  for (const auto& e : events) {
    arr.push_back(json{{"type", e.type}, {"payload", e.payload}});
  }
  json out{{"events", arr}, {"cursor", cursor}, {"done", streams_.is_done(stream_id)}};
  if (const auto result = streams_.result(stream_id)) out["result"] = *result;
  return out;
}

}  // namespace omega::runtime
