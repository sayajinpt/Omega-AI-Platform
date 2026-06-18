#include "omega/runtime/services/office_visualization_service.hpp"

#include "omega/runtime/paths.hpp"

#include <httplib.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <process.h>
#pragma comment(lib, "ws2_32.lib")
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr int kDefaultGatewayPort = 18789;

std::string profile_file(ProfileContext& profile, const char* name) {
  return (fs::path(profile.profile_home()) / name).string();
}

struct OfficeLaunchPaths {
  std::string cwd;
  std::string script;  // e.g. server.js or server\index.js
};

OfficeLaunchPaths resolve_office_launch(const std::string& office_root) {
  // Custom server (gateway WS proxy at /api/gateway/ws) — required for live 3D office.
  const fs::path root = fs::path(office_root);
  if (fs::exists(root / "server" / "index.js")) {
    return {root.string(), "server\\index.js"};
  }
  const fs::path nested =
      root / ".next" / "standalone" / "apps" / "desktop" / "claw3d-office";
  if (fs::exists(nested / "server.js")) return {nested.string(), "server.js"};
  const fs::path flat = root / ".next" / "standalone";
  if (fs::exists(flat / "server.js")) return {flat.string(), "server.js"};
  return {root.string(), "server\\index.js"};
}

#ifdef _WIN32
/** httplib::Server::bind_to_port leaves the socket open on destruction — do not use for probing. */
bool tcp_port_bindable(const char* host, int port) {
  SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock == INVALID_SOCKET) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<u_short>(port));
  if (InetPtonA(AF_INET, host, &addr.sin_addr) != 1) {
    closesocket(sock);
    return false;
  }
  const bool ok = bind(sock, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
  closesocket(sock);
  return ok;
}

void terminate_process_tree(unsigned long pid) {
  if (pid == 0) return;
  HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, static_cast<DWORD>(pid));
  if (h) {
    TerminateProcess(h, 0);
    CloseHandle(h);
  }
  std::string cmd = "taskkill /PID " + std::to_string(pid) + " /T /F";
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<char> buf(cmd.begin(), cmd.end());
  buf.push_back('\0');
  if (CreateProcessA(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr,
                    &si, &pi)) {
    WaitForSingleObject(pi.hProcess, 5000);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
}

bool spawn_node_with_log(const std::string& node_exe, const std::string& cwd,
                         const std::string& script_path, const std::string& log_path,
                         void** out_handle) {
  HANDLE log_file =
      CreateFileA(log_path.c_str(), FILE_APPEND_DATA,
                  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                  nullptr);
  if (log_file == INVALID_HANDLE_VALUE) return false;

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = INVALID_HANDLE_VALUE;
  si.hStdOutput = log_file;
  si.hStdError = log_file;

  std::string cmdline = "\"" + node_exe + "\" \"" + script_path + "\"";
  std::vector<char> buf(cmdline.begin(), cmdline.end());
  buf.push_back('\0');

  PROCESS_INFORMATION pi{};
  const BOOL ok =
      CreateProcessA(node_exe.c_str(), buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                   cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
  CloseHandle(log_file);
  if (!ok) return false;
  CloseHandle(pi.hThread);
  *out_handle = pi.hProcess;
  return true;
}
#endif

}  // namespace

OfficeVisualizationService::OfficeVisualizationService(ProfileContext& profile) : profile_(profile) {}

bool OfficeVisualizationService::standalone_runtime_ready(const fs::path& standalone_nm) const {
  return fs::exists(standalone_nm / "next" / "package.json") &&
         fs::exists(standalone_nm / "ws" / "package.json") &&
         fs::exists(standalone_nm / "baseline-browser-mapping" / "package.json") &&
         fs::exists(standalone_nm / "caniuse-lite" / "package.json");
}

bool OfficeVisualizationService::office_built(const std::string& office_root) const {
  const fs::path root = fs::path(office_root);
  const fs::path standalone_nm = fs::path(resolve_claw3d_standalone_node_modules());
  if (!fs::exists(root / ".next" / "BUILD_ID")) return false;
  if (!fs::exists(root / "server" / "index.js")) return false;
  if (!standalone_runtime_ready(standalone_nm)) return false;
  const OfficeLaunchPaths launch = resolve_office_launch(office_root);
  return fs::exists(fs::path(launch.cwd) / launch.script);
}

std::string OfficeVisualizationService::read_office_log_hint() const {
  const fs::path log_path = fs::path(profile_.profile_home()) / "logs" / "office-view.log";
  if (!fs::exists(log_path)) return {};
  try {
    std::ifstream in(log_path, std::ios::binary);
    if (!in) return {};
    in.seekg(0, std::ios::end);
    const std::streampos end_pos = in.tellg();
    if (end_pos == std::streampos(-1)) return {};
    const std::streamoff size = static_cast<std::streamoff>(end_pos);
    constexpr std::streamoff k_tail = 4096;
    const std::streamoff start = size > k_tail ? size - k_tail : 0;
    in.seekg(start, std::ios::beg);
    std::string tail((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    const auto pos = tail.rfind("MODULE_NOT_FOUND");
    if (pos != std::string::npos) {
      const auto line_start = tail.rfind('\n', pos);
      const auto line_end = tail.find('\n', pos);
      return tail.substr(line_start == std::string::npos ? 0 : line_start + 1,
                         line_end == std::string::npos ? std::string::npos : line_end - line_start - 1);
    }
    if (tail.find("EADDRINUSE") != std::string::npos) {
      return "Office port already in use (EADDRINUSE). Close other Office instances or restart Omega.";
    }
    const auto err = tail.rfind("Error:");
    if (err != std::string::npos) {
      const auto line_end = tail.find('\n', err);
      return tail.substr(err, line_end == std::string::npos ? std::string::npos : line_end - err);
    }
  } catch (...) {
  }
  return {};
}

int OfficeVisualizationService::read_port() const {
  const fs::path p = profile_file(profile_, "claw3d-port");
  if (!fs::exists(p)) return 3010;
  try {
    std::ifstream in(p);
    int port = 3010;
    in >> port;
    return port > 0 ? port : 3010;
  } catch (...) {
    return 3010;
  }
}

void OfficeVisualizationService::write_port(int port) const {
  std::ofstream out(profile_file(profile_, "claw3d-port"));
  out << port;
}

std::string OfficeVisualizationService::read_ws_url() const {
  const fs::path p = profile_file(profile_, "claw3d-ws-url");
  if (!fs::exists(p)) return "ws://127.0.0.1:" + std::to_string(kDefaultGatewayPort);
  try {
    std::ifstream in(p);
    std::string url;
    std::getline(in, url);
    return url.empty() ? ("ws://127.0.0.1:" + std::to_string(kDefaultGatewayPort)) : url;
  } catch (...) {
    return "ws://127.0.0.1:" + std::to_string(kDefaultGatewayPort);
  }
}

void OfficeVisualizationService::write_ws_url(const std::string& url) const {
  std::ofstream out(profile_file(profile_, "claw3d-ws-url"));
  out << url;
}

bool OfficeVisualizationService::office_http_ready(int port) const {
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(2, 0);
  cli.set_read_timeout(2, 0);
  const auto res = cli.Get("/office?omega_embed=1");
  return res && res->status >= 200 && res->status < 500;
}

bool OfficeVisualizationService::gateway_ready() const {
  httplib::Client cli("127.0.0.1", kDefaultGatewayPort);
  cli.set_connection_timeout(1, 0);
  cli.set_read_timeout(1, 0);
  const auto res = cli.Get("/health");
  return res && res->status >= 200 && res->status < 300;
}

int OfficeVisualizationService::pick_office_port() const {
#ifdef _WIN32
  for (int port = 3010; port < 3110; ++port) {
    if (office_http_ready(port)) return port;
    if (tcp_port_bindable("127.0.0.1", port)) return port;
  }
#endif
  return 3010;
}

void OfficeVisualizationService::write_office_pid(unsigned long pid) const {
  std::ofstream out(profile_file(profile_, "claw3d-office.pid"));
  out << pid;
}

void OfficeVisualizationService::write_adapter_pid(unsigned long pid) const {
  std::ofstream out(profile_file(profile_, "claw3d-adapter.pid"));
  out << pid;
}

void OfficeVisualizationService::clear_pid_files() const {
  std::error_code ec;
  fs::remove(profile_file(profile_, "claw3d-office.pid"), ec);
  fs::remove(profile_file(profile_, "claw3d-adapter.pid"), ec);
}

bool OfficeVisualizationService::pid_file_running(const char* name) const {
  const fs::path p = profile_file(profile_, name);
  if (!fs::exists(p)) return false;
  try {
    std::ifstream in(p);
    unsigned long pid = 0;
    in >> pid;
    if (pid == 0) return false;
#ifdef _WIN32
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
    if (!h) return false;
    DWORD code = 0;
    const bool alive = GetExitCodeProcess(h, &code) && code == STILL_ACTIVE;
    CloseHandle(h);
    return alive;
#else
    return kill(static_cast<pid_t>(pid), 0) == 0;
#endif
  } catch (...) {
    return false;
  }
}

void OfficeVisualizationService::terminate_pid_file(const char* name) const {
  const fs::path p = profile_file(profile_, name);
  if (!fs::exists(p)) return;
  try {
    std::ifstream in(p);
    unsigned long pid = 0;
    in >> pid;
#ifdef _WIN32
    if (pid > 0) terminate_process_tree(pid);
#else
    if (pid > 0) kill(static_cast<pid_t>(pid), SIGTERM);
#endif
  } catch (...) {
  }
  std::error_code ec;
  fs::remove(p, ec);
}

json OfficeVisualizationService::status() const {
  const std::string office_root = resolve_claw3d_office_root();
  const bool built = office_built(office_root);
  const int port = read_port();
  const bool office_proc = pid_file_running("claw3d-office.pid");
  const bool office_up = office_http_ready(port);
  const bool gw_up = gateway_ready();
  std::string err;
  if (!built) {
    const fs::path standalone_nm = fs::path(resolve_claw3d_standalone_node_modules());
    if (!fs::exists(standalone_nm / "baseline-browser-mapping" / "package.json") ||
        !fs::exists(standalone_nm / "caniuse-lite" / "package.json")) {
      err = "Office runtime incomplete (missing Next.js browser data). Re-run build.bat and reinstall.";
    } else {
      err = "claw3d-office bundle missing or incomplete. Re-run build.bat and reinstall.";
    }
  } else if (office_proc && !office_up) {
    err = read_office_log_hint();
    if (err.empty()) {
      err = "Office server process running but HTTP not ready — see %USERPROFILE%\\.omega\\logs\\office-view.log";
    }
  }
  const bool process_claimed = office_proc || office_up;
  json out{{"installed", built},
           {"bundled", built},
           {"running", process_claimed},
           {"processActive", office_proc},
           {"devServerRunning", office_up},
           {"officeReady", office_up},
           {"adapterRunning", gw_up},
           {"gatewayReady", gw_up},
           {"port", port},
           {"wsUrl", read_ws_url()},
           {"officeUrl", "http://127.0.0.1:" + std::to_string(port)},
           {"nativeEmbed", false},
           {"message", office_up ? "Office server running" : "Start office view from the Office page"}};
  if (!err.empty()) out["error"] = err;
  return out;
}

json OfficeVisualizationService::setup() const {
  const std::string office_root = resolve_claw3d_office_root();
  const bool built = office_built(office_root);
  json out{{"ok", built},
           {"installed", built},
           {"log", built ? "Office bundle is present.\n"
                         : "claw3d-office is not built. Re-run build.bat and reinstall Omega.\n"}};
  if (!built) {
    const fs::path standalone_nm = fs::path(resolve_claw3d_standalone_node_modules());
    if (fs::exists(fs::path(office_root) / ".next" / "BUILD_ID") &&
        !standalone_runtime_ready(standalone_nm)) {
      out["error"] =
          "Office runtime incomplete (missing baseline-browser-mapping or caniuse-lite). "
          "Re-run build.bat and reinstall.";
    } else {
      out["error"] = fs::exists(fs::path(office_root) / ".next" / "BUILD_ID")
                         ? "claw3d-office runtime trace missing (.next/standalone/node_modules). Reinstall Omega."
                         : "claw3d-office build missing";
    }
  }
  return out;
}

json OfficeVisualizationService::start() {
  std::lock_guard lock(mu_);
  const std::string office_root = resolve_claw3d_office_root();
  if (!office_built(office_root)) {
    return json{{"success", false},
                {"error", "claw3d-office is not installed. Re-run build.bat and reinstall Omega."}};
  }
  const std::string node = resolve_node_binary();
  if (node.empty()) {
    return json{{"success", false},
                {"error", "Node.js not found. Install Node 20+ or set OMEGA_NODE_BIN."}};
  }

  stop_unlocked();

  const OfficeLaunchPaths launch = resolve_office_launch(office_root);
  write_ws_url("ws://127.0.0.1:" + std::to_string(kDefaultGatewayPort));

  const fs::path logs_dir = fs::path(profile_.profile_home()) / "logs";
  fs::create_directories(logs_dir);
  const std::string log_path = (logs_dir / "office-view.log").string();
  const std::string standalone_nm = resolve_claw3d_standalone_node_modules();
  if (!standalone_runtime_ready(fs::path(standalone_nm))) {
    return json{{"success", false},
                {"error",
                 "claw3d-office runtime incomplete (Next standalone missing ws, baseline-browser-mapping, "
                 "or caniuse-lite). Re-run build.bat and reinstall Omega."}};
  }

#ifdef _WIN32
  bool ready = false;
  int port = 3010;
  for (int attempt = 0; attempt < 20 && !ready; ++attempt) {
    port = pick_office_port();
    office_port_ = port;
    write_port(port);

    if (office_http_ready(port)) {
      ready = true;
      break;
    }

    const std::string script_path = (fs::path(launch.cwd) / launch.script).string();
    const std::string gateway_ws = "ws://127.0.0.1:" + std::to_string(kDefaultGatewayPort);
    SetEnvironmentVariableA("PORT", std::to_string(port).c_str());
    SetEnvironmentVariableA("HOSTNAME", "127.0.0.1");
    SetEnvironmentVariableA("NODE_ENV", "production");
    SetEnvironmentVariableA("CLAW3D_GATEWAY_URL", gateway_ws.c_str());
    SetEnvironmentVariableA("NODE_PATH", standalone_nm.c_str());

    if (!spawn_node_with_log(node, launch.cwd, script_path, log_path, &office_process_)) {
      return json{{"success", false}, {"error", "Failed to start claw3d office server"}};
    }
    DWORD office_pid = GetProcessId(static_cast<HANDLE>(office_process_));
    write_office_pid(office_pid);

    for (int i = 0; i < 90; ++i) {
      if (office_http_ready(port)) {
        ready = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    if (!ready) stop_unlocked();
  }
  if (!ready) {
    std::string hint = read_office_log_hint();
    if (hint.empty()) {
      hint = "Office HTTP server did not become ready. See %USERPROFILE%\\.omega\\logs\\office-view.log";
    }
    return json{{"success", false}, {"error", hint}};
  }

  const std::string adapter = resolve_claw3d_adapter_script();
  if (!fs::exists(adapter)) {
    return json{{"success", false}, {"error", "omega-claw3d-adapter.mjs not found in package"}};
  }
  const std::string adapter_cwd = fs::path(adapter).parent_path().string();
  const char* runtime_port = std::getenv("OMEGA_RUNTIME_PORT");
  const int omega_port = runtime_port ? std::atoi(runtime_port) : 9877;
  SetEnvironmentVariableA("OMEGA_API_URL",
                          ("http://127.0.0.1:" + std::to_string(omega_port)).c_str());
  SetEnvironmentVariableA("CLAW3D_ADAPTER_PORT", std::to_string(kDefaultGatewayPort).c_str());
  SetEnvironmentVariableA("CLAW3D_WS_NODE_MODULES", standalone_nm.c_str());
  if (!spawn_node_with_log(node, adapter_cwd, adapter, log_path, &adapter_process_)) {
    return json{{"success", false},
                {"error", "Office server started but gateway adapter failed to launch"}};
  }
  DWORD adapter_pid = GetProcessId(static_cast<HANDLE>(adapter_process_));
  write_adapter_pid(adapter_pid);

  bool gw = false;
  for (int i = 0; i < 40; ++i) {
    if (gateway_ready()) {
      gw = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
  }

  return json{{"success", true},
              {"officeReady", true},
              {"gatewayReady", gw},
              {"port", port},
              {"officeUrl", "http://127.0.0.1:" + std::to_string(port)}};
#else
  (void)node;
  (void)port;
  return json{{"success", false},
              {"error", "3D office start is not implemented on this platform yet."}};
#endif
}

void OfficeVisualizationService::stop_unlocked() {
#ifdef _WIN32
  if (office_process_) {
    terminate_process_tree(GetProcessId(static_cast<HANDLE>(office_process_)));
    CloseHandle(static_cast<HANDLE>(office_process_));
    office_process_ = nullptr;
  }
  if (adapter_process_) {
    terminate_process_tree(GetProcessId(static_cast<HANDLE>(adapter_process_)));
    CloseHandle(static_cast<HANDLE>(adapter_process_));
    adapter_process_ = nullptr;
  }
#endif
  terminate_pid_file("claw3d-office.pid");
  terminate_pid_file("claw3d-adapter.pid");
  clear_pid_files();
}

json OfficeVisualizationService::stop() {
  std::lock_guard lock(mu_);
  stop_unlocked();
  return json{{"success", true}, {"ok", true}};
}

}  // namespace omega::runtime
