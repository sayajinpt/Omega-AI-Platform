#pragma once

#include <string>

namespace omega::shell {

/** Spawn omega-runtime.exe and wait for /healthz (port 9877). */
class RuntimeSupervisor {
 public:
  RuntimeSupervisor();
  ~RuntimeSupervisor();

  RuntimeSupervisor(const RuntimeSupervisor&) = delete;
  RuntimeSupervisor& operator=(const RuntimeSupervisor&) = delete;

  void start();
  void stop();
  bool ready() const { return ready_; }
  std::string last_error() const { return last_error_; }

 private:
  bool wait_for_health(int port, int attempts = 60);
  void* process_handle_{nullptr};
  void* job_handle_{nullptr};
  unsigned long process_id_{0};
  bool ready_{false};
  std::string last_error_;
};

}  // namespace omega::shell
