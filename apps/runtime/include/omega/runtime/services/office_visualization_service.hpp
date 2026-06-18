#pragma once

#include "omega/runtime/profile_context.hpp"

#include <filesystem>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class OfficeVisualizationService {
 public:
  explicit OfficeVisualizationService(ProfileContext& profile);

  nlohmann::json status() const;
  nlohmann::json setup() const;
  nlohmann::json start();
  nlohmann::json stop();

 private:
  void stop_unlocked();
  bool standalone_runtime_ready(const std::filesystem::path& standalone_nm) const;
  bool office_built(const std::string& office_root) const;
  std::string read_office_log_hint() const;
  int read_port() const;
  void write_port(int port) const;
  std::string read_ws_url() const;
  void write_ws_url(const std::string& url) const;
  bool office_http_ready(int port) const;
  bool gateway_ready() const;
  int pick_office_port() const;
  void write_office_pid(unsigned long pid) const;
  void write_adapter_pid(unsigned long pid) const;
  void clear_pid_files() const;
  bool pid_file_running(const char* name) const;
  void terminate_pid_file(const char* name) const;

  ProfileContext& profile_;
  mutable std::mutex mu_;
#ifdef _WIN32
  void* office_process_{nullptr};
  void* adapter_process_{nullptr};
#endif
  int office_port_{0};
};

}  // namespace omega::runtime
