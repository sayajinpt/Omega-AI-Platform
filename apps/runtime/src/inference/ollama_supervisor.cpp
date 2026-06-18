#include "omega/runtime/inference/ollama_supervisor.hpp"

#include "omega/runtime/config_store.hpp"
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

httplib::Client ollama_client(int port) {
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(5, 0);
  return cli;
}

}  // namespace

OllamaSupervisor& OllamaSupervisor::instance() {
  static OllamaSupervisor sup;
  return sup;
}

int OllamaSupervisor::active_port() const {
  const fs::path state = fs::path(omega_home()) / "ollama-state.json";
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

void OllamaSupervisor::persist_state() const {
  if (port_ <= 0) return;
  try {
    const fs::path state = fs::path(omega_home()) / "ollama-state.json";
    fs::create_directories(state.parent_path());
    std::ofstream out(state);
    out << json{{"port", port_},
                {"baseUrl", "http://127.0.0.1:" + std::to_string(port_)},
                {"startedAt", now_ms()}}
               .dump(2);
  } catch (...) {
  }
}

void OllamaSupervisor::apply_spawn_env(int port) const {
#ifdef _WIN32
  ConfigStore config;
  const json cfg = config.load();
  const std::string models = cfg.value("modelsDir", models_dir());
  const bool cloud = cfg.value("ollamaCloudEnabled", false);

  const std::string host = "127.0.0.1:" + std::to_string(port);
  SetEnvironmentVariableA("OLLAMA_HOST", host.c_str());
  SetEnvironmentVariableA("OLLAMA_MODELS", models.c_str());
  SetEnvironmentVariableA("OLLAMA_KEEP_ALIVE", "5m");
  SetEnvironmentVariableA("OLLAMA_NUM_PARALLEL", "1");
  SetEnvironmentVariableA("OLLAMA_NOPRUNE", "1");
  SetEnvironmentVariableA("OLLAMA_DEBUG", "0");
  SetEnvironmentVariableA("HOME", omega_home().c_str());
  if (cloud) {
    SetEnvironmentVariableA("OLLAMA_NO_CLOUD", nullptr);
  } else {
    SetEnvironmentVariableA("OLLAMA_NO_CLOUD", "1");
  }
#else
  (void)port;
#endif
}

int OllamaSupervisor::allocate_free_port() const {
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

bool OllamaSupervisor::health_check(int port) const {
  if (port <= 0) return false;
  auto cli = ollama_client(port);
  cli.set_read_timeout(2, 0);
  const auto res = cli.Get("/api/version");
  return res && res->status >= 200 && res->status < 300;
}

bool OllamaSupervisor::wait_ready(int port) const {
  for (int i = 0; i < 60; ++i) {
    if (health_check(port)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  return false;
}

#ifdef _WIN32
bool OllamaSupervisor::try_spawn(int port) {
  const std::string exe = resolve_ollama_binary();
  if (!fs::exists(exe)) return false;
  if (process_handle_) {
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(static_cast<HANDLE>(process_handle_), &code) && code == STILL_ACTIVE) {
      return health_check(port);
    }
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }

  apply_spawn_env(port);

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::string cmd = "\"" + exe + "\" serve";
  if (!CreateProcessA(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      nullptr, &si, &pi)) {
    return false;
  }
  process_handle_ = pi.hProcess;
  CloseHandle(pi.hThread);
  return true;
}
#else
bool OllamaSupervisor::try_spawn(int /*port*/) { return false; }
#endif

bool OllamaSupervisor::ensure_started() {
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

std::string OllamaSupervisor::base_url() {
  if (!ensure_started()) {
    const int saved = active_port();
    if (saved > 0) return "http://127.0.0.1:" + std::to_string(saved);
    return "http://127.0.0.1:11434";
  }
  std::lock_guard lock(mu_);
  return "http://127.0.0.1:" + std::to_string(port_);
}

json OllamaSupervisor::status() const {
  const int port = active_port();
  const bool up = health_check(port);
  json out{{"available", fs::exists(resolve_ollama_binary())},
           {"running", up},
           {"port", port > 0 ? json(port) : json(nullptr)},
           {"baseUrl", port > 0 ? json("http://127.0.0.1:" + std::to_string(port)) : json(nullptr)}};
  if (up && port > 0) {
    try {
      auto cli = ollama_client(port);
      cli.set_read_timeout(3, 0);
      const auto res = cli.Get("/api/version");
      if (res && res->status >= 200 && res->status < 300) {
        const json body = json::parse(res->body);
        if (body.contains("version")) out["version"] = body["version"];
      }
    } catch (...) {
    }
  }
  if (!up && fs::exists(resolve_ollama_binary())) {
    out["error"] = "ollama not running";
  }
  return out;
}

json OllamaSupervisor::list_models() {
  if (!ensure_started()) throw std::runtime_error("ollama not running");
  std::lock_guard lock(mu_);
  auto cli = ollama_client(port_);
  cli.set_read_timeout(30, 0);
  const auto res = cli.Get("/api/tags");
  if (!res || res->status < 200 || res->status >= 300) {
    throw std::runtime_error("ollama list models failed");
  }
  const json body = json::parse(res->body);
  json models = json::array();
  if (body.contains("models") && body["models"].is_array()) {
    for (const auto& m : body["models"]) {
      models.push_back(json{{"name", m.value("name", "")},
                            {"size", m.value("size", 0)},
                            {"modified_at", m.value("modified_at", "")}});
    }
  }
  return models;
}

void OllamaSupervisor::parse_progress_lines(std::string& buffer,
                                              OllamaProgressCallback on_progress) const {
  size_t pos = 0;
  while ((pos = buffer.find('\n')) != std::string::npos) {
    std::string line = buffer.substr(0, pos);
    buffer.erase(0, pos + 1);
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty()) continue;
    try {
      const json j = json::parse(line);
      if (on_progress) on_progress(j);
    } catch (...) {
    }
  }
}

json OllamaSupervisor::pull_model(const std::string& name, OllamaProgressCallback on_progress) {
  if (name.empty()) throw std::runtime_error("model name required");
  if (!ensure_started()) throw std::runtime_error("ollama not running");

  int port = 0;
  {
    std::lock_guard lock(mu_);
    port = port_;
  }

  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(3600, 0);

  std::string line_buffer;
  httplib::Request req;
  req.method = "POST";
  req.path = "/api/pull";
  req.set_header("Content-Type", "application/json");
  req.body = json{{"name", name}, {"stream", true}}.dump();
  req.content_receiver = [this, &line_buffer, on_progress, name](const char* data, size_t len,
                                                                  uint64_t, uint64_t) {
    line_buffer.append(data, len);
    parse_progress_lines(line_buffer, [&](const json& j) {
      if (on_progress) {
        json payload = j;
        payload["name"] = name;
        on_progress(payload);
      }
    });
    return true;
  };

  httplib::Response res;
  httplib::Error err;
  if (!cli.send(req, res, err)) {
    throw std::runtime_error("ollama pull failed: " + httplib::to_string(err));
  }
  if (res.status < 200 || res.status >= 300) {
    throw std::runtime_error("ollama pull HTTP " + std::to_string(res.status));
  }

  parse_progress_lines(line_buffer, [&](const json& j) {
    if (on_progress) {
      json payload = j;
      payload["name"] = name;
      on_progress(payload);
    }
  });

  return json{{"ok", true}, {"name", name}};
}

void OllamaSupervisor::stop() {
  std::lock_guard lock(mu_);
#ifdef _WIN32
  if (process_handle_) {
    TerminateProcess(static_cast<HANDLE>(process_handle_), 0);
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }
#endif
  running_ = false;
  port_ = 0;
}

}  // namespace omega::runtime
