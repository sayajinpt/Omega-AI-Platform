#pragma once

#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ConfigStore;

/** Lazy-start Python sidecar (ONNX GenAI / EXL2) and proxy load + chat HTTP. */
class SidecarSupervisor {
 public:
  static SidecarSupervisor& instance();

  bool ensure_started();
  void stop();
  nlohmann::json status() const;
  std::string base_url() const;

  nlohmann::json load_model(const std::string& model_id, const std::string& path,
                            const std::string& format, int max_seq_len = 8192);
  nlohmann::json unload_model();

  std::string loaded_model_id() const;
  std::string loaded_model_path() const;
  std::string loaded_format() const;

 private:
  SidecarSupervisor() = default;

  bool health_check(int port) const;
  bool wait_ready(int port) const;
  bool try_spawn(int port);
  int allocate_free_port() const;
  int active_port() const;
  void persist_state() const;

  mutable std::mutex mu_;
  int port_ = 0;
  bool running_ = false;
  std::string loaded_model_id_;
  std::string loaded_model_path_;
  std::string loaded_format_;
#ifdef _WIN32
  void* process_handle_ = nullptr;
#endif
};

}  // namespace omega::runtime
