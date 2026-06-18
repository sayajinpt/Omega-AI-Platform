#pragma once

#include <functional>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

using OllamaProgressCallback = std::function<void(const nlohmann::json&)>;

/** Lazy-start bundled Ollama on a private loopback port and expose its base URL. */
class OllamaSupervisor {
 public:
  static OllamaSupervisor& instance();

  std::string base_url();
  bool ensure_started();
  void stop();
  nlohmann::json status() const;
  nlohmann::json list_models();
  nlohmann::json pull_model(const std::string& name, OllamaProgressCallback on_progress = nullptr);

 private:
  OllamaSupervisor() = default;

  bool health_check(int port) const;
  bool wait_ready(int port) const;
  bool try_spawn(int port);
  int allocate_free_port() const;
  int active_port() const;
  void persist_state() const;
  void apply_spawn_env(int port) const;
  void parse_progress_lines(std::string& buffer, OllamaProgressCallback on_progress) const;

  mutable std::mutex mu_;
  int port_ = 0;
  bool running_ = false;
#ifdef _WIN32
  void* process_handle_ = nullptr;
#endif
};

}  // namespace omega::runtime
