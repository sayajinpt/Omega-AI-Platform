#pragma once

#include <functional>
#include <nlohmann/json.hpp>
#include <mutex>
#include <optional>
#include <string>

namespace omega::runtime {

using ChatTokenCallback = std::function<void(const std::string& text, int index)>;
using ChatMetricsCallback = std::function<void(const nlohmann::json& stats)>;

/** Engine lifecycle events forwarded from the stdout reader thread. */
using EngineEventCallback =
    std::function<void(const std::string& event_type, const nlohmann::json& payload)>;

/** JSON-line client for omega-engine (stdio). */
class EngineClient {
 public:
  EngineClient();
  ~EngineClient();

  bool available() const;
  std::string last_error() const;
  bool ensure_started();
  /** Terminate omega-engine (e.g. before CPU retry after a hung GPU load). */
  void stop();

  /** Called for ModelLoaded / ModelUnloaded (and other events if extended later). */
  void set_event_handler(EngineEventCallback handler);

  /** Invoked when the engine process exits or stdin writes fail (stdout reader thread). */
  void set_failure_handler(std::function<void(const std::string& reason)> handler);

  /** Synchronous command — waits for matching response id. */
  nlohmann::json command(const std::string& type, const nlohmann::json& payload,
                         int timeout_ms = 120000);

  /** chat.send with streaming tokens; session_id is command id + event sessionId. */
  nlohmann::json chat_send(const nlohmann::json& payload, const std::string& session_id,
                           ChatTokenCallback on_token,
                           ChatMetricsCallback on_metrics = {},
                           int timeout_ms = 600000);

  nlohmann::json chat_abort(const std::string& session_id);

 private:
  void ingest_line(const std::string& line);
  void notify_process_exited(const std::string& reason);
  void shutdown_process_handles();

  struct Impl;
  Impl* impl_;
};

}  // namespace omega::runtime
