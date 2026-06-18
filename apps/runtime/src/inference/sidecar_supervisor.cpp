#include "omega/runtime/inference/sidecar_supervisor.hpp"

#include "omega/runtime/paths.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <stdexcept>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

#ifdef _WIN32
void ensure_wsa() {
  static bool ready = []() {
    WSADATA wsa{};
    return WSAStartup(MAKEWORD(2, 2), &wsa) == 0;
  }();
  (void)ready;
}
#endif

httplib::Client sidecar_client(int port) {
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(600, 0);
  return cli;
}

fs::path sidecar_state_file() { return fs::path(omega_home()) / "sidecar-state.json"; }

}  // namespace

SidecarSupervisor& SidecarSupervisor::instance() {
  static SidecarSupervisor sup;
  return sup;
}

int SidecarSupervisor::active_port() const {
  const fs::path state = sidecar_state_file();
  if (fs::exists(state)) {
    try {
      std::ifstream in(state);
      const json j = json::parse(in);
      if (j.contains("port")) return j["port"].get<int>();
    } catch (...) {
    }
  }
  return port_;
}

void SidecarSupervisor::persist_state() const {
  if (port_ <= 0) return;
  try {
    const fs::path state = sidecar_state_file();
    fs::create_directories(state.parent_path());
    std::ofstream out(state);
    out << json{{"port", port_},
                {"baseUrl", "http://127.0.0.1:" + std::to_string(port_)},
                {"startedAt", now_ms()}}
               .dump(2);
  } catch (...) {
  }
}

int SidecarSupervisor::allocate_free_port() const {
#ifdef _WIN32
  ensure_wsa();
  SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == INVALID_SOCKET) return 0;

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  addr.sin_port = 0;

  if (bind(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    closesocket(sock);
    return 0;
  }

  int len = sizeof(addr);
  if (getsockname(sock, reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
    closesocket(sock);
    return 0;
  }

  const int port = ntohs(addr.sin_port);
  closesocket(sock);
  return port > 0 ? port : 0;
#else
  return 0;
#endif
}

bool SidecarSupervisor::health_check(int port) const {
  if (port <= 0) return false;
  auto cli = sidecar_client(port);
  cli.set_read_timeout(2, 0);
  const auto res = cli.Get("/health");
  return res && res->status >= 200 && res->status < 300;
}

bool SidecarSupervisor::wait_ready(int port) const {
  for (int i = 0; i < 120; ++i) {
    if (health_check(port)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  return false;
}

#ifdef _WIN32
bool SidecarSupervisor::try_spawn(int port) {
  const std::string py = resolve_sidecar_python();
  const fs::path server = fs::path(resolve_engines_root()) / "sidecar" / "server.py";
  if (!fs::exists(py) || !fs::exists(server)) return false;

  if (process_handle_) {
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(static_cast<HANDLE>(process_handle_), &code) && code == STILL_ACTIVE) {
      return health_check(port);
    }
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }

  const fs::path sidecar_dir = server.parent_path();
  const std::string cmd =
      "\"" + py + "\" \"" + server.string() + "\" --host 127.0.0.1 --port " + std::to_string(port);
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<char> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back('\0');
  if (!CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      sidecar_dir.string().c_str(), &si, &pi)) {
    return false;
  }
  process_handle_ = pi.hProcess;
  CloseHandle(pi.hThread);
  return true;
}
#else
bool SidecarSupervisor::try_spawn(int /*port*/) { return false; }
#endif

bool SidecarSupervisor::ensure_started() {
  std::lock_guard lock(mu_);

  if (running_ && port_ > 0 && health_check(port_)) return true;

  const int saved = active_port();
  if (saved > 0 && health_check(saved)) {
    port_ = saved;
    running_ = true;
    return true;
  }

  const int port = allocate_free_port();
  if (port <= 0) return false;

  if (!try_spawn(port)) return false;
  port_ = port;

  if (!wait_ready(port_)) return health_check(port_);

  running_ = true;
  persist_state();
  return true;
}

std::string SidecarSupervisor::base_url() const {
  const int saved = active_port();
  if (saved > 0) return "http://127.0.0.1:" + std::to_string(saved);
  std::lock_guard lock(mu_);
  if (port_ > 0) return "http://127.0.0.1:" + std::to_string(port_);
  return "http://127.0.0.1:0";
}

json SidecarSupervisor::status() const {
  const int port = active_port();
  json health = json::object();
  if (port > 0 && health_check(port)) {
    try {
      auto cli = sidecar_client(port);
      cli.set_read_timeout(2, 0);
      const auto res = cli.Get("/health");
      if (res && res->status >= 200 && res->status < 300) health = json::parse(res->body);
    } catch (...) {
    }
  }
  std::lock_guard lock(mu_);
  return json{{"running", port > 0 && health_check(port)},
              {"port", port},
              {"baseUrl", port > 0 ? ("http://127.0.0.1:" + std::to_string(port)) : ""},
              {"loadedModelId", loaded_model_id_},
              {"loadedModelPath", loaded_model_path_},
              {"loadedFormat", loaded_format_},
              {"health", health}};
}

json SidecarSupervisor::load_model(const std::string& model_id, const std::string& path,
                                   const std::string& format, int max_seq_len) {
  if (path.empty()) throw std::runtime_error("sidecar load requires path");
  if (!ensure_started()) throw std::runtime_error("sidecar server unavailable");
  const int port = active_port();
  auto cli = sidecar_client(port);
  const json body{{"path", path}, {"format", format}, {"max_seq_len", max_seq_len}};
  const auto res = cli.Post("/internal/load", body.dump(), "application/json");
  if (!res) throw std::runtime_error("sidecar load request failed");
  if (res->status < 200 || res->status >= 300) {
    throw std::runtime_error("sidecar load HTTP " + std::to_string(res->status) + ": " +
                             res->body.substr(0, 400));
  }
  std::lock_guard lock(mu_);
  loaded_model_id_ = model_id;
  loaded_model_path_ = path;
  loaded_format_ = format;
  return json::parse(res->body);
}

json SidecarSupervisor::unload_model() {
  if (!ensure_started()) return json{{"ok", true}};
  const int port = active_port();
  auto cli = sidecar_client(port);
  const auto res = cli.Post("/internal/unload", "{}", "application/json");
  std::lock_guard lock(mu_);
  loaded_model_id_.clear();
  loaded_model_path_.clear();
  loaded_format_.clear();
  if (!res || res->status < 200 || res->status >= 300) {
    return json{{"ok", false}};
  }
  return json::parse(res->body);
}

void SidecarSupervisor::stop() {
#ifdef _WIN32
  if (process_handle_) {
    TerminateProcess(static_cast<HANDLE>(process_handle_), 0);
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }
#endif
  {
    std::lock_guard lock(mu_);
    loaded_model_id_.clear();
    loaded_model_path_.clear();
    loaded_format_.clear();
    running_ = false;
    port_ = 0;
  }
}

std::string SidecarSupervisor::loaded_model_id() const {
  std::lock_guard lock(mu_);
  return loaded_model_id_;
}

std::string SidecarSupervisor::loaded_model_path() const {
  std::lock_guard lock(mu_);
  return loaded_model_path_;
}

std::string SidecarSupervisor::loaded_format() const {
  std::lock_guard lock(mu_);
  return loaded_format_;
}

}  // namespace omega::runtime
