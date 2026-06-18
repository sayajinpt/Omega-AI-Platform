#include "omega/shell/runtime_supervisor.hpp"

#include "omega/shell/app_paths.hpp"

#include <httplib.h>

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#error "runtime_supervisor_posix.cpp is for POSIX builds only"
#else
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace omega::shell {

namespace {

constexpr int kRuntimePort = 9877;

bool http_health_ok(int port) {
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(1, 0);
  const auto res = cli.Get("/healthz");
  return res && res->status == 200;
}

void set_child_env() {
  setenv("OMEGA_HOME", omega_home().c_str(), 1);
  setenv("OMEGA_RUNTIME_PORT", std::to_string(kRuntimePort).c_str(), 1);
  setenv("OMEGA_SHELL_URL", "http://127.0.0.1:9878", 1);
  const std::string path = augmented_path();
  if (!path.empty()) setenv("PATH", path.c_str(), 1);
  const std::string engine = engine_binary_path();
  if (file_exists(engine)) setenv("OMEGA_ENGINE_BIN", engine.c_str(), 1);
  const std::string ollama = ollama_binary_path();
  if (file_exists(ollama)) setenv("OMEGA_OLLAMA_BIN", ollama.c_str(), 1);
}

}  // namespace

RuntimeSupervisor::RuntimeSupervisor() = default;

RuntimeSupervisor::~RuntimeSupervisor() { stop(); }

void RuntimeSupervisor::start() {
  if (ready_) return;

  const std::string bin = runtime_binary_path();
  if (!file_exists(bin)) {
    last_error_ = "omega-runtime missing: " + bin;
    throw std::runtime_error(last_error_);
  }

  pid_t child = fork();
  if (child < 0) {
    last_error_ = "fork failed for omega-runtime";
    throw std::runtime_error(last_error_);
  }

  if (child == 0) {
    set_child_env();
    const std::string port_arg = std::to_string(kRuntimePort);
    execl(bin.c_str(), bin.c_str(), "--port", port_arg.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }

  process_id_ = static_cast<unsigned long>(child);
  process_handle_ = reinterpret_cast<void*>(static_cast<intptr_t>(child));

  if (!wait_for_health(kRuntimePort)) {
    last_error_ = "omega-runtime did not respond on /healthz";
    stop();
    throw std::runtime_error(last_error_);
  }

  ready_ = true;
  last_error_.clear();
}

void RuntimeSupervisor::stop() {
  if (process_id_ > 0) {
    const pid_t pid = static_cast<pid_t>(process_id_);
    kill(pid, SIGTERM);
    int status = 0;
    for (int i = 0; i < 40; ++i) {
      const pid_t r = waitpid(pid, &status, WNOHANG);
      if (r == pid || r == -1) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (waitpid(pid, &status, WNOHANG) == 0) {
      kill(pid, SIGKILL);
      waitpid(pid, &status, 0);
    }
  }
  process_handle_ = nullptr;
  process_id_ = 0;
  ready_ = false;
}

bool RuntimeSupervisor::wait_for_health(int port, int attempts) {
  for (int i = 0; i < attempts; ++i) {
    if (http_health_ok(port)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  return false;
}

}  // namespace omega::shell
