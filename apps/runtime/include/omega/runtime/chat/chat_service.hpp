#pragma once

#include "omega/runtime/chat/stream_hub.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/storage/soul_store.hpp"
#include "omega/runtime/storage/usage_store.hpp"
#include "omega/runtime/tools/tool_registry.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/storage/input_pipeline_store.hpp"
#include "omega/runtime/storage/project_store.hpp"

#include <atomic>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>

namespace omega::runtime {

class ChatService {
 public:
  ChatService(ConfigStore& config, EngineClient& engine, SessionStore& sessions,
              ToolRegistry& tools, StreamHub& streams, MemoryStore& memory, SoulStore& soul,
              EventBus& events, InferenceRouter& router, InputPipelineStore& pipelines,
              ProjectStore& projects, UsageStore& usage);

  nlohmann::json send(const nlohmann::json& req);
  nlohmann::json abort(const std::string& stream_id);
  nlohmann::json poll_stream(const std::string& stream_id, size_t& cursor);

 private:
  bool llm_orchestrator_enabled() const;
  /** Two-phase PROMPT_1 → PROMPT_2 omega_turn planning (opt-in; default is universal tool loop). */
  bool orchestrator_two_phase_enabled() const;
  std::string format_memory_context(const std::string& query) const;
  std::string soul_text() const;

  void emit_stream_token(const std::string& stream_id, const std::string& text, int index);
  void emit_stream_done(const std::string& stream_id, const nlohmann::json& result);
  void emit_stream_error(const std::string& stream_id, const std::string& error);
  void begin_stream_metrics(const std::string& stream_id, const std::string& model_id,
                            int prompt_tokens_est, const std::string& backend);
  void apply_stream_token_counts(const std::string& stream_id, int tokens_in, int tokens_out);
  void apply_stream_measured_stats(const std::string& stream_id, const nlohmann::json& stats);
  void emit_stream_metrics(const std::string& stream_id, const std::string& phase);
  ChatMetricsCallback make_stream_metrics_handler(const std::string& stream_id);
  void finalize_stream_measured_stats(const std::string& stream_id, int tokens_in, int tokens_out,
                                      int64_t prompt_ms, int64_t gen_ms);
  void end_stream_metrics(const std::string& stream_id);
  void emit_agent_step(const nlohmann::json& step);
  void emit_session_message(const std::string& session_id, const std::string& role,
                            const std::string& content, const nlohmann::json& extras = nullptr);
  void persist_assistant_message(const std::string& session_id, const std::string& prose,
                                 const std::vector<nlohmann::json>& tool_results);

  std::string build_agent_system_prompt(const nlohmann::json& dialog,
                                        const std::string& session_id,
                                        int context_tokens = 8192) const;
  nlohmann::json trim_for_model(const nlohmann::json& messages, const std::string& model_id,
                                bool agent_mode) const;
  void attach_chat_engine_options(const nlohmann::json& req, const std::string& model_id,
                                  nlohmann::json& payload) const;
  nlohmann::json run_simple_chat(const nlohmann::json& req, const std::string& stream_id,
                                 const std::string& session_id);
  nlohmann::json run_agent_chat(const nlohmann::json& req, const std::string& stream_id,
                                const std::string& session_id);
  /** Model-family-agnostic tool loop: multi-format parse, stream every round, pipeline proxies. */
  nlohmann::json run_universal_agent_tool_loop(const nlohmann::json& req,
                                               const std::string& stream_id,
                                               const std::string& session_id,
                                               const nlohmann::json& dialog,
                                               const nlohmann::json& messages_no_system,
                                               bool metrics_already_started = false);
  nlohmann::json run_orchestrator_agent_chat(const nlohmann::json& req,
                                             const std::string& stream_id,
                                             const std::string& session_id);
  nlohmann::json finish_agent_turn(const std::string& stream_id, const std::string& session_id,
                                   const std::string& model, const nlohmann::json& dialog,
                                   const std::vector<nlohmann::json>& tool_results,
                                   std::string final_text, int64_t start_ms,
                                   int total_tokens_in, int total_tokens_out);
  /** Skip LLM when user clearly asked for image/video generation — run inferred tools immediately. */
  std::optional<nlohmann::json> try_bootstrap_inferred_media_tools(
      const std::string& stream_id, const std::string& session_id, const std::string& model,
      const nlohmann::json& dialog, const std::string& query, int64_t start_ms);

  ConfigStore& config_;
  EngineClient& engine_;
  SessionStore& sessions_;
  ToolRegistry& tools_;
  StreamHub& streams_;
  MemoryStore& memory_;
  SoulStore& soul_;
  EventBus& events_;
  InferenceRouter& router_;
  InputPipelineStore& pipelines_;
  ProjectStore& projects_;
  UsageStore& usage_;
  std::mutex abort_mu_;
  std::unordered_map<std::string, std::atomic<bool>> abort_flags_;
  std::mutex engine_session_mu_;
  std::unordered_map<std::string, std::string> active_engine_sessions_;
};

}  // namespace omega::runtime
