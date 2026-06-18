#pragma once

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>

namespace omega::runtime {

class ConfigStore;
class ContentStudioSettings;
class ContentStudioSupervisor;
class DebugStore;
class EngineClient;
class MediaPlayerService;
class ProfileContext;
class ProjectStore;
class SessionStore;

/** Content Studio webhook cache + chat deliverables (native replacement for Electron delivery). */
class ContentJobDeliveryService {
 public:
  void attach(SessionStore* sessions, ProjectStore* projects, ProfileContext* profile,
              ContentStudioSupervisor* content_studio, EngineClient* engine, EventBus* events,
              ConfigStore* config, ContentStudioSettings* cs_settings,
              MediaPlayerService* media_player = nullptr);
  void attach_debug(DebugStore* debug);
  /** Sync ``RuntimeContext`` model cache + publish ``omega:runtime:status-changed`` (query_engine=true). */
  void set_runtime_status_publisher(std::function<void(const std::string& reason)> publisher);
  /** Invoke ``RuntimeContext::reload_chat_model_after_content_studio`` (blocking on caller thread). */
  void set_chat_model_reloader(
      std::function<void(const std::string& model_id, const std::string& job_id)> reloader);

  /** Cancel non-terminal Content Studio jobs tied to a chat session before starting a new render. */
  void cancel_active_jobs_for_session(const std::string& session_id);
  /** Cancel jobs, clear delivery caches, and drop reload-after-job state for a deleted chat. */
  void purge_session(const std::string& session_id);

  /** Unload chat model after max_performance Content Studio render is queued; reload on job finish. */
  void prepare_max_performance_job(const std::string& session_id, const std::string& model_id,
                                   const std::string& title, const std::string& theme);
  /** Remember chat model for post-job reload / UI refresh without unloading (keep_agent). */
  void remember_reload_after_job(const std::string& session_id, const std::string& model_id,
                                 const std::string& title, const std::string& theme,
                                 bool unloaded_chat_model = false);

  nlohmann::json handle_webhook(const nlohmann::json& body, EventBus& events);
  nlohmann::json register_job(const nlohmann::json& body);
  /** Register job + poll status; does not patch chat messages (caller attaches card via tool parts). */
  void track_job(const std::string& job_id, const std::string& session_id,
                 const std::string& project_id);
  /** Track async direct T2V (no Content Studio project / watcher). */
  void track_direct_video_job(const std::string& job_id, const std::string& session_id);
  /** After async direct T2V render: free GPU, reload chat model, patch chat card. */
  void complete_direct_video_job(EventBus& events, const std::string& session_id,
                                 const std::string& job_id, bool failed,
                                 const std::string& error_hint,
                                 const nlohmann::json& video_part, const std::string& title,
                                 int64_t started_at_ms = 0);
  nlohmann::json ensure_card(const nlohmann::json& body, EventBus& events);
  std::optional<nlohmann::json> get_cached(const std::string& job_id) const;
  void register_session(const std::string& job_id, const std::string& session_id);
  void clear_job(const std::string& job_id);

 private:
  struct PatchResult {
    std::string content;
    nlohmann::json parts;
    int message_index{-1};
  };

  void start_watcher(const std::string& job_id, const std::string& session_id,
                     const std::string& project_id);
  void stop_watcher(const std::string& job_id);
  /** Stop watcher without joining — safe from finalize worker (avoids self-join deadlock). */
  void drop_watcher(const std::string& job_id);
  void schedule_chat_model_reload_async(const std::string& model_id, const std::string& job_id);
  void update_job_card(const std::string& session_id, const std::string& job_id,
                       const std::string& project_id, const std::string& status,
                       const nlohmann::json& run_status, EventBus& events);
  struct ReloadMeta {
    std::string model_id;
    std::string title;
    std::string theme;
    bool unloaded_chat_model{false};
  };

  /** Queue chat reload as soon as a job finishes — do not wait on finalize worker (can stall). */
  void schedule_post_cs_chat_reload_if_needed(const std::string& session_id,
                                              const std::string& job_id,
                                              const std::string& status);
  std::string resolve_reload_model_id(const ReloadMeta* meta) const;

  void release_chat_model_for_content_studio(const std::string& model_id);
  void release_content_studio_gpu();
  /** Wait for CS worker exit + pipeline idle before omega-engine reload (VRAM handoff). */
  void wait_for_job_gpu_release(const std::string& job_id);
  bool reload_chat_model_after_job(const std::string& model_id, bool force,
                                   const std::string& except_job_id = "");
  std::optional<ReloadMeta> consume_reload_after_job(const std::string& session_id,
                                                     const std::string& job_id = "");
  void deliver_resume_note(EventBus& events, const std::string& session_id, bool failed,
                           const ReloadMeta& meta, bool video_ready,
                           const std::string& error_hint, bool model_reloaded,
                           bool direct_t2v = false);
  bool has_active_content_job(const std::string& except_job_id = "") const;
  bool is_chat_model_loaded(const std::string& model_id) const;
  void signal_watcher_stop(const std::string& job_id);
  void try_finalize_delivery(const std::string& job_id, const nlohmann::json& body,
                             EventBus& events);
  void run_finalize_delivery_worker(const std::string& job_id, const std::string& session_id,
                                    const std::string& project_id, nlohmann::json body,
                                    EventBus& events);
  std::optional<PatchResult> patch_job_message(
      const std::string& session_id, const std::string& job_id,
      const std::function<void(nlohmann::json& parts, std::string& content)>& mutator);
  std::optional<PatchResult> patch_direct_video_card(const std::string& session_id,
                                                     const std::string& job_id,
                                                     const nlohmann::json& card,
                                                     const nlohmann::json& video_part);
  nlohmann::json import_mp4_to_session(const std::string& session_id,
                                       const std::string& relative_mp4) const;
  void publish_assistant_patch(EventBus& events, const std::string& session_id,
                               const std::string& job_id, const PatchResult& patch);
  void cs_log(const std::string& message, const std::string& level = "info",
              const nlohmann::json& data = nlohmann::json::object()) const;
  void publish_runtime_model_status(const std::string& reason);
  void schedule_chat_model_reload(const std::string& model_id, const std::string& job_id);

  SessionStore* sessions_{nullptr};
  ProjectStore* projects_{nullptr};
  ProfileContext* profile_{nullptr};
  ContentStudioSupervisor* content_studio_{nullptr};
  EngineClient* engine_{nullptr};
  EventBus* events_{nullptr};
  ConfigStore* config_{nullptr};
  ContentStudioSettings* cs_settings_{nullptr};
  MediaPlayerService* media_player_{nullptr};
  DebugStore* debug_{nullptr};
  std::function<void(const std::string& reason)> runtime_status_publisher_;
  std::function<void(const std::string& model_id, const std::string& job_id)> chat_model_reloader_;

  mutable std::mutex mu_;
  std::unordered_map<std::string, ReloadMeta> reload_after_job_;
  std::unordered_map<std::string, ReloadMeta> reload_by_job_;
  /** Sessions where max_performance unloaded the chat model — survives until finalize reload. */
  std::unordered_set<std::string> sessions_chat_unloaded_;
  std::unordered_set<std::string> reload_scheduled_jobs_;
  std::mutex watch_mu_;
  std::unordered_map<std::string, nlohmann::json> cache_;
  std::unordered_map<std::string, std::string> session_by_job_;
  std::unordered_map<std::string, std::string> project_by_job_;
  std::unordered_set<std::string> delivered_;
  std::unordered_set<std::string> cancelled_;
  std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> watcher_stop_;
  std::unordered_map<std::string, std::thread> watcher_threads_;
};

}  // namespace omega::runtime
