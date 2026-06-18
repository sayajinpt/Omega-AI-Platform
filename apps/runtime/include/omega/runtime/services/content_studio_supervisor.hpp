#pragma once

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class ContentStudioSettings;
class DebugStore;
class PythonSupervisor;

class ContentStudioSupervisor {
 public:
  void attach_settings(ContentStudioSettings* settings);
  void attach_python(PythonSupervisor* python);
  void attach_debug(DebugStore* debug);

  nlohmann::json status() const;
  nlohmann::json start();
  nlohmann::json stop();
  nlohmann::json restart();
  void ensure_started();
  /** Venv + migrations only (default on-demand mode, no uvicorn). */
  void ensure_ready();
  nlohmann::json api(const std::string& method, const std::string& path,
                     const nlohmann::json& body = nlohmann::json::object());
  nlohmann::json cancel_run(const std::string& job_id);
  /** Poll until no pipeline worker or queued/running job remains (returns false on timeout). */
  bool wait_for_pipeline_idle(int timeout_ms = 12000);
  nlohmann::json force_stop_job(const nlohmann::json& opts);
  nlohmann::json connect_youtube_oauth(EventBus& events, class ContentStudioSettings& settings);
  nlohmann::json download_generation_model(const nlohmann::json& req, EventBus& events);
  void sync_settings_to_api();

  /** Spawn ``python -m app.workers.run_job`` detached from omega-runtime (on-demand mode). */
  bool spawn_pipeline_worker(const std::string& job_id);

  /** On-demand ``python -m app.cli.cs_invoke <command>`` (no uvicorn). */
  nlohmann::json invoke_cli(const std::string& command, const nlohmann::json& request);

 private:
  void cs_log(const std::string& message, const std::string& level = "info",
              const nlohmann::json& data = nlohmann::json::object()) const;

  ContentStudioSettings* settings_{nullptr};
  PythonSupervisor* python_{nullptr};
  DebugStore* debug_{nullptr};
  mutable std::mutex mu_;
  std::mutex invoke_cli_mu_;
  std::mutex start_mu_;
  std::atomic<bool> running_{false};
  std::atomic<bool> ready_{false};
  int port_{0};
  std::string last_error_;
  bool use_uvicorn_mode() const;
  nlohmann::json api_via_cli(const std::string& method, const std::string& path,
                             const nlohmann::json& body);
  std::string build_cli_env_prefix() const;
  /** Env vars for pipeline worker subprocess (parity with v1 queue._submit_subprocess). */
  std::map<std::string, std::string> studio_worker_env() const;
  /** Caller must hold start_mu_. */
  nlohmann::json ensure_ready_impl();
#ifdef _WIN32
  void* process_handle_{nullptr};
#else
  int process_pid_{0};
#endif
  int pick_free_port() const;
  bool wait_ready(int port, int deadline_ms) const;
  int port_or_throw() const;
  bool is_process_alive_locked() const;
  bool probe_api_health(int port) const;
  /** Caller must hold start_mu_. */
  nlohmann::json start_impl();
  /** Caller must hold start_mu_. */
  nlohmann::json stop_impl();
  /** Caller must hold mu_. */
  nlohmann::json status_locked() const;
};

}  // namespace omega::runtime
