#pragma once

#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class ConfigStore;
class ContentJobDeliveryService;
class DebugStore;
class ContentStudioSettings;
class ContentStudioSupervisor;
class EngineClient;
class EventBus;
class PipelineActivityService;
class ProjectStore;
class SessionStore;

/** Content Studio agent orchestration: script generation, pending runs, full API payloads. */
class ContentStudioOrchestrator {
 public:
  void attach(ContentStudioSupervisor* content_studio, ContentJobDeliveryService* delivery,
              ContentStudioSettings* settings, ConfigStore* config, EngineClient* engine,
              SessionStore* sessions, ProjectStore* projects, EventBus* events,
              PipelineActivityService* pipeline);
  void attach_debug(DebugStore* debug);

  nlohmann::json run_tool(const std::string& name,
                          const std::map<std::string, std::string>& args);

  /** After briefing choices, generate script and show GPU mode. */
  std::optional<nlohmann::json> try_resume_after_briefing_choice(const std::string& session_id,
                                                                 const std::string& user_message);

  /** When a script is pending and the user picked keep_agent / max_performance, start the render. */
  std::optional<nlohmann::json> try_resume_after_gpu_choice(const std::string& session_id,
                                                            const std::string& user_message);

  /** Clear pending Content Studio run state when a chat is deleted. */
  void discard_session(const std::string& session_id);

 private:
  struct PendingRun {
    nlohmann::json run_args = nlohmann::json::object();
    nlohmann::json script = nlohmann::json::object();
    /** briefing = awaiting creative choices; awaiting_gpu = script ready */
    std::string phase;
  };

  nlohmann::json create_run(const std::map<std::string, std::string>& args);
  nlohmann::json generate_script(const std::map<std::string, std::string>& args);
  /** LLM tool entry only — briefing or re-show in-progress steps; never queues a render. */
  nlohmann::json handle_llm_chat_video_request(const std::map<std::string, std::string>& merged,
                                               const std::string& session_id);
  /** After script + GPU choice — POST pipeline job, show card, optionally unload chat model. */
  nlohmann::json submit_chat_render(std::map<std::string, std::string> merged,
                                    const std::string& session_id, const nlohmann::json& script,
                                    const std::string& gpu_mode);
  nlohmann::json generate_t2v_prompt(const std::map<std::string, std::string>& args);
  nlohmann::json submit_direct_t2v(std::map<std::string, std::string> merged,
                                   const std::string& session_id, const nlohmann::json& script,
                                   const std::string& gpu_mode);
  nlohmann::json build_run_body(const std::map<std::string, std::string>& args,
                                const nlohmann::json& script) const;
  std::optional<nlohmann::json> parse_script_json(const std::string& text) const;
  std::optional<nlohmann::json> parse_t2v_prompt_json(const std::string& text) const;
  void sync_settings_to_api() const;
  std::string webhook_url() const;
  std::string resolve_model_id() const;
  nlohmann::json storage_report(const std::map<std::string, std::string>& args) const;
  nlohmann::json storage_cleanup(const std::map<std::string, std::string>& args) const;
  std::string build_briefing_choices(const std::map<std::string, std::string>& args) const;
  void set_pending(const std::string& session_id, PendingRun pending);
  std::optional<PendingRun> get_pending(const std::string& session_id) const;
  void clear_pending(const std::string& session_id);
  void cs_log(const std::string& message, const std::string& level = "info",
              const nlohmann::json& data = nlohmann::json::object()) const;

  ContentStudioSupervisor* content_studio_{nullptr};
  ContentJobDeliveryService* delivery_{nullptr};
  ContentStudioSettings* settings_{nullptr};
  ConfigStore* config_{nullptr};
  EngineClient* engine_{nullptr};
  SessionStore* sessions_{nullptr};
  ProjectStore* projects_{nullptr};
  EventBus* events_{nullptr};
  PipelineActivityService* pipeline_{nullptr};
  DebugStore* debug_{nullptr};

  mutable std::mutex pending_mu_;
  mutable std::map<std::string, PendingRun> pending_by_session_;
};

}  // namespace omega::runtime
