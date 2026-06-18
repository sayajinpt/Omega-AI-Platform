#include "omega/runtime/services/content_studio_supervisor.hpp"

#include "omega/runtime/services/content_studio_native_status.hpp"
#include "omega/runtime/debug_log.hpp"
#include "omega/runtime/services/debug_store.hpp"
#include "omega/runtime/python/python_supervisor.hpp"
#include "omega/runtime/python/venv_setup.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/shell_bridge.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <atomic>
#include <cstring>
#include <deque>
#include <fstream>
#include <filesystem>
#include <functional>
#include <future>
#include <map>
#include <vector>
#include <httplib.h>
#include <mutex>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
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
#include <shellapi.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

void ContentStudioSupervisor::attach_debug(DebugStore* debug) { debug_ = debug; }

void ContentStudioSupervisor::cs_log(const std::string& message, const std::string& level,
                                     const json& data) const {
  emit_debug(debug_, "content-studio", message, level, data);
}

namespace {

json parse_api_response(const httplib::Result& res, const std::string& path) {
  if (!res) throw std::runtime_error("Content Studio API unreachable: " + path);
  if (res->status >= 200 && res->status < 300) {
    if (res->status == 204 || res->body.empty()) return json::object();
    return json::parse(res->body);
  }
  try {
    const json err = json::parse(res->body);
    if (err.contains("detail") && err["detail"].is_string()) {
      throw std::runtime_error(err["detail"].get<std::string>());
    }
  } catch (const json::exception&) {
  }
  throw std::runtime_error(res->body.empty() ? ("HTTP " + std::to_string(res->status) + " " + path)
                                             : res->body);
}

#ifdef _WIN32
int run_capture_lines(const std::string& cmd, const std::function<void(const std::string&)>& on_line) {
  FILE* pipe = _popen(cmd.c_str(), "r");
  if (!pipe) return -1;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) {
    std::string line = buf;
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (!line.empty() && on_line) on_line(line);
  }
  return _pclose(pipe);
}
#endif

#ifndef _WIN32
int run_capture_lines(const std::string& cmd, const std::function<void(const std::string&)>& on_line) {
  FILE* pipe = popen(cmd.c_str(), "r");
  if (!pipe) return -1;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) {
    std::string line = buf;
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (!line.empty() && on_line) on_line(line);
  }
  return pclose(pipe);
}
#endif

std::string shell_quote_local(const std::string& s) {
#ifdef _WIN32
  if (s.find_first_of(" \t\"") == std::string::npos) return s;
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += "\"";
  return out;
#else
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
#endif
}

bool python_import_ok(const std::string& py, const std::string& module, std::string* err_out = nullptr) {
  const std::string cmd =
      shell_quote_local(py) + " -c " + shell_quote_local("import " + module) + " 2>&1";
  std::string err;
  const int code = run_capture_lines(cmd, [&](const std::string& line) {
    if (!err.empty()) err += "\n";
    err += line;
  });
  if (code == 0) return true;
  if (err_out) *err_out = err.empty() ? ("failed to import " + module) : err;
  return false;
}

std::string python_backend_path_literal(const std::string& backend) {
  std::error_code ec;
  fs::path abs = fs::weakly_canonical(fs::path(backend), ec);
  if (ec || abs.empty()) abs = fs::absolute(backend);
  std::string s = abs.string();
#ifdef _WIN32
  for (char& c : s) {
    if (c == '\\') c = '/';
  }
#endif
  std::string out = "r'";
  for (char c : s) {
    if (c == '\'') out += "\\'";
    else out += c;
  }
  out += "'";
  return out;
}

std::string python_run_in_backend(const std::string& py, const std::string& backend,
                                  const std::string& code) {
  const std::string wrapped = "import sys; sys.path.insert(0, " + python_backend_path_literal(backend) +
                              "); " + code;
  return shell_quote_local(py) + " -c " + shell_quote_local(wrapped) + " 2>&1";
}

bool content_studio_app_import_ok(const std::string& py, const std::string& backend) {
  return run_capture_lines(python_run_in_backend(py, backend, "from app.main import app"), nullptr) ==
         0;
}

bool content_studio_stack_import_ok(const std::string& py, const std::string& backend) {
  return run_capture_lines(python_run_in_backend(py, backend, "from app.database import SessionLocal"),
                            nullptr) == 0;
}

bool content_studio_api_packages_ready(const std::string& py) {
  if (!fs::exists(py)) return false;
  const std::string backend = resolve_content_studio_backend();
  if (!fs::exists(backend)) return false;
  return content_studio_stack_import_ok(py, backend);
}

bool content_studio_local_media_ready(const std::string& py) {
  if (!fs::exists(py)) return false;
  const std::string import_cmd =
      shell_quote_local(py) + " -c " +
      shell_quote_local("import torch; import diffusers; from qwen_tts import Qwen3TTSModel") +
      " 2>&1";
  return run_capture_lines(import_cmd, nullptr) == 0;
}

bool unified_venv_setup_complete() {
  const fs::path profile_file = fs::path(omega_home()) / "venvs" / "unified" / ".omega-profile";
  if (!fs::exists(profile_file)) return false;
  try {
    std::ifstream in(profile_file);
    const nlohmann::json profile = nlohmann::json::parse(in);
    return profile.value("setupComplete", false) == true;
  } catch (...) {
    return false;
  }
}

void append_log_tail(std::deque<std::string>& tail, const std::string& line, size_t max_lines = 12) {
  tail.push_back(line);
  while (tail.size() > max_lines) tail.pop_front();
}

std::string tail_to_string(const std::deque<std::string>& tail) {
  std::ostringstream out;
  bool first = true;
  for (const auto& line : tail) {
    if (!first) out << '\n';
    first = false;
    out << line;
  }
  return out.str();
}

std::string windows_env_prefix(const std::string& key, const std::string& value) {
  if (value.empty()) return {};
  std::ostringstream oss;
  oss << "set \"" << key << '=';
  for (char c : value) {
    if (c == '"') oss << "\\\"";
    else oss << c;
  }
  oss << "\" && ";
  return oss.str();
}

bool generation_download_stack_ready(const std::string& py, const std::string& gen_models,
                                     std::string* err_out = nullptr) {
  const std::string import_cmd =
      shell_quote_local(py) + " -c " +
      shell_quote_local("import localgen.downloads") + " 2>&1";
  std::string err;
  if (run_capture_lines(import_cmd, [&](const std::string& line) {
        if (!err.empty()) err += "\n";
        err += line;
      }) == 0) {
    return true;
  }
  if (gen_models.empty()) {
    if (err_out) *err_out = err.empty() ? "localgen.downloads import failed" : err;
    return false;
  }
#ifdef _WIN32
  const std::string py_path_cmd =
      windows_env_prefix("PYTHONPATH", gen_models) + import_cmd;
#else
  const std::string py_path_cmd =
      "PYTHONPATH=" + shell_quote_local(gen_models) + " " + import_cmd;
#endif
  err.clear();
  if (run_capture_lines(py_path_cmd, [&](const std::string& line) {
        if (!err.empty()) err += "\n";
        err += line;
      }) == 0) {
    return true;
  }
  if (err_out) *err_out = err.empty() ? "localgen.downloads import failed" : err;
  return false;
}

uint64_t folder_size_bytes(const fs::path& root) {
  if (!fs::exists(root)) return 0;
  uint64_t total = 0;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied,
                                                   ec);
       it != fs::recursive_directory_iterator(); ++it) {
    if (it->is_regular_file(ec)) {
      total += static_cast<uint64_t>(it->file_size(ec));
    }
  }
  return total;
}

/** Bytes under ``root`` excluding ``.cache/`` (HF hub staging — not deployable weights). */
uint64_t deployable_folder_size_bytes(const fs::path& root) {
  if (!fs::exists(root)) return 0;
  uint64_t total = 0;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied,
                                                   ec);
       it != fs::recursive_directory_iterator(); ++it) {
    if (!it->is_regular_file(ec)) continue;
    bool in_cache = false;
    for (const auto& part : it->path()) {
      if (part == ".cache") {
        in_cache = true;
        break;
      }
    }
    if (in_cache) continue;
    total += static_cast<uint64_t>(it->file_size(ec));
  }
  return total;
}

uint64_t parse_size_hint_bytes(const std::string& hint) {
  if (hint.empty()) return 0;
  std::string lower;
  lower.reserve(hint.size());
  for (char c : hint) {
    if (c == '~') continue;
    lower += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  std::smatch match;
  static const std::regex num_re(R"((\d+(?:\.\d+)?))");
  if (!std::regex_search(lower, match, num_re)) return 0;
  double val = 0;
  try {
    val = std::stod(match[1].str());
  } catch (...) {
    return 0;
  }
  uint64_t mult = 1;
  if (lower.find("gb") != std::string::npos)
    mult = 1024ULL * 1024 * 1024;
  else if (lower.find("mb") != std::string::npos)
    mult = 1024ULL * 1024;
  else if (lower.find("kb") != std::string::npos)
    mult = 1024ULL;
  return static_cast<uint64_t>(val * static_cast<double>(mult));
}

std::string format_byte_label(uint64_t bytes) {
  if (bytes >= 1024ULL * 1024 * 1024) {
    return std::to_string(bytes / (1024ULL * 1024 * 1024)) + " GB";
  }
  if (bytes >= 1024ULL * 1024) {
    return std::to_string(bytes / (1024ULL * 1024)) + " MB";
  }
  if (bytes >= 1024ULL) {
    return std::to_string(bytes / 1024ULL) + " KB";
  }
  return std::to_string(bytes) + " B";
}

void publish_cs_download_progress(EventBus& events, const std::string& repo, const std::string& status,
                                  uint64_t done, uint64_t total, uint64_t speed_bps) {
  double pct = 0;
  if (status == "complete") {
    pct = 100;
  } else if (total > 0 && done > 0) {
    pct = std::min(99.9, 100.0 * static_cast<double>(done) / static_cast<double>(total));
  } else if (done > 0) {
    pct = std::min(95.0, static_cast<double>(done) / (200.0 * 1024 * 1024) * 100.0);
  }

  std::string detail = status;
  if (status == "downloading" || status == "starting") {
    detail = format_byte_label(done);
    if (total > 0) detail += " / " + format_byte_label(total);
    else detail += " on disk";
  }

  events.publish("omega:download:progress",
                   json{{"repo", repo},
                        {"filename", "(Content Studio snapshot)"},
                        {"bytes_done", done},
                        {"bytes_total", total},
                        {"percent", pct},
                        {"speed_bps", speed_bps},
                        {"status", status},
                        {"detail", detail}});
}

constexpr const char* kDownloadProgressPrefix = "OMEGA_DL_PROGRESS ";

bool try_parse_download_progress_line(const std::string& line, uint64_t* done, uint64_t* total,
                                      uint64_t* speed_bps) {
  if (line.rfind(kDownloadProgressPrefix, 0) != 0) return false;
  const json j = json::parse(line.substr(std::strlen(kDownloadProgressPrefix)), nullptr, false);
  if (j.is_discarded() || !j.is_object()) return false;
  if (done) *done = j.value("bytes_done", 0ULL);
  if (total) *total = j.value("bytes_total", 0ULL);
  if (speed_bps) *speed_bps = j.value("speed_bps", 0ULL);
  return true;
}

std::mutex g_generation_download_mu;
std::set<std::string> g_generation_download_active;

void run_generation_download_job(const std::string& repo_id, const fs::path& dest,
                                 const std::string& cmd_str, uint64_t expected_bytes,
                                 EventBus& events) {
  publish_cs_download_progress(events, repo_id, "starting", 0, expected_bytes, 0);

  int exit_code = -1;
  std::deque<std::string> log_tail;
  std::optional<json> result_json;
  exit_code = run_capture_lines(cmd_str, [&](const std::string& line) {
    append_log_tail(log_tail, line);
    uint64_t done = 0;
    uint64_t total = 0;
    uint64_t speed = 0;
    if (try_parse_download_progress_line(line, &done, &total, &speed)) {
      if (total == 0 && expected_bytes > 0) total = expected_bytes;
      publish_cs_download_progress(events, repo_id, "downloading", done, total, speed);
      return;
    }
    const json parsed = json::parse(line, nullptr, false);
    if (!parsed.is_discarded() && parsed.is_object() && parsed.value("verified", false)) {
      result_json = parsed;
      return;
    }
    static const std::regex pct_re(R"((\d+)%\|)");
    std::smatch pct_match;
    if (!std::regex_search(line, pct_match, pct_re)) return;
    const uint64_t bytes = deployable_folder_size_bytes(dest);
    try {
      const int pct = std::stoi(pct_match[1].str());
      const uint64_t est_total = expected_bytes > 0 ? expected_bytes : bytes;
      const uint64_t est_done =
          est_total > 0 ? static_cast<uint64_t>(static_cast<double>(est_total) * pct / 100.0) : bytes;
      publish_cs_download_progress(events, repo_id, "downloading", est_done, est_total, 0);
    } catch (...) {
    }
  });

  const bool verified = result_json.has_value() && result_json->value("verified", false);
  if (exit_code != 0 || !verified) {
    publish_cs_download_progress(events, repo_id, "error", deployable_folder_size_bytes(dest),
                                 expected_bytes, 0);
    return;
  }

  const uint64_t final_bytes = deployable_folder_size_bytes(dest);
  publish_cs_download_progress(events, repo_id, "complete", final_bytes,
                               expected_bytes > 0 ? expected_bytes : final_bytes, 0);
  events.publish("omega:models:inventoryChanged", json::object());
}

std::string read_tail_file(const fs::path& path, size_t max_chars = 4000) {
  if (!fs::exists(path)) return {};
  try {
    std::ifstream in(path);
    std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (content.size() <= max_chars) return content;
    return content.substr(content.size() - max_chars);
  } catch (...) {
    return {};
  }
}

#ifdef _WIN32
DWORD process_exit_code(void* handle) {
  if (!handle) return STILL_ACTIVE;
  DWORD code = STILL_ACTIVE;
  if (!GetExitCodeProcess(static_cast<HANDLE>(handle), &code)) return STILL_ACTIVE;
  return code;
}
#endif

}  // namespace

void ContentStudioSupervisor::attach_settings(ContentStudioSettings* settings) {
  settings_ = settings;
}

void ContentStudioSupervisor::attach_python(PythonSupervisor* python) {
  python_ = python;
}

#ifdef _WIN32
namespace {
bool tcp_port_bindable_cs(const char* host, int port) {
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
}  // namespace
#endif

int ContentStudioSupervisor::pick_free_port() const {
  for (int port = 18700; port < 19700; port += 3) {
#ifdef _WIN32
    if (tcp_port_bindable_cs("127.0.0.1", port)) return port;
#else
    httplib::Server probe;
    if (probe.bind_to_port("127.0.0.1", port)) return port;
#endif
  }
  return 18789;
}

bool ContentStudioSupervisor::wait_ready(int port, int deadline_ms) const {
  const auto start = std::chrono::steady_clock::now();
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(3, 0);
  cli.set_read_timeout(5, 0);
  while (std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() -
                                                               start)
             .count() < deadline_ms) {
#ifdef _WIN32
    {
      std::lock_guard lock(mu_);
      if (process_handle_) {
        DWORD code = STILL_ACTIVE;
        if (GetExitCodeProcess(static_cast<HANDLE>(process_handle_), &code) && code != STILL_ACTIVE) {
          return false;
        }
      }
    }
#endif
    if (auto res = cli.Get("/health")) {
      if (res->status >= 200 && res->status < 300) return true;
    }
    if (auto res = cli.Get("/api/agent/v1/info")) {
      if (res->status >= 200 && res->status < 300) return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  return false;
}

int ContentStudioSupervisor::port_or_throw() const {
  std::lock_guard lock(mu_);
  if (!running_.load() || port_ <= 0) {
    throw std::runtime_error("Content Studio API is not running");
  }
  return port_;
}

bool ContentStudioSupervisor::is_process_alive_locked() const {
#ifdef _WIN32
  if (!process_handle_) return false;
  return process_exit_code(process_handle_) == STILL_ACTIVE;
#else
  if (process_pid_ <= 0) return false;
  return kill(process_pid_, 0) == 0;
#endif
}

bool ContentStudioSupervisor::probe_api_health(int port) const {
  if (port <= 0) return false;
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(2, 0);
  cli.set_read_timeout(3, 0);
  if (auto res = cli.Get("/health")) {
    if (res->status >= 200 && res->status < 300) return true;
  }
  if (auto res = cli.Get("/api/agent/v1/info")) {
    if (res->status >= 200 && res->status < 300) return true;
  }
  return false;
}

bool ContentStudioSupervisor::use_uvicorn_mode() const {
  if (const char* env = std::getenv("OMEGA_CS_UVICORN")) {
    const std::string v(env);
    return v == "1" || v == "true" || v == "yes" || v == "on";
  }
  return false;
}

json ContentStudioSupervisor::status_locked() const {
  const std::string py = resolve_unified_python();
  const std::string backend = resolve_content_studio_backend();
  const bool setup_running = python_ && python_->setup_running();
  const bool venv_ready = fs::exists(py);
  const bool setup_complete = venv_ready && !setup_running && unified_venv_setup_complete();
  const bool api_packages_ready = setup_complete;
  const bool local_media_ready = setup_complete;
  const bool uvicorn = use_uvicorn_mode();
  const bool on_demand_ready = !uvicorn && ready_.load();
  const bool is_running = uvicorn ? running_.load() : on_demand_ready;
  json out{{"available", fs::exists(backend)},
           {"running", is_running},
           {"ready", ready_.load()},
           {"mode", uvicorn ? "uvicorn" : "on-demand"},
           {"venvReady", venv_ready},
           {"apiPackagesReady", api_packages_ready},
           {"mediaPackagesReady", local_media_ready},
           {"localMediaReady", local_media_ready},
           {"setupRunning", setup_running},
           {"repoPath", backend},
           {"port", uvicorn ? port_ : 0},
           {"baseUrl", (uvicorn && port_ > 0) ? ("http://127.0.0.1:" + std::to_string(port_)) : ""}};
  if (!last_error_.empty()) out["error"] = last_error_;
  return out;
}

json ContentStudioSupervisor::status() const {
  std::lock_guard lock(mu_);
  return status_locked();
}

void ContentStudioSupervisor::sync_settings_to_api() {
  if (!settings_) return;
  try {
    json payload =
        settings_->credentials_to_api_payload(settings_->load_credentials());
    const json gen_payload =
        settings_->generation_to_api_payload(settings_->load_generation());
    for (auto it = gen_payload.begin(); it != gen_payload.end(); ++it) {
      payload[it.key()] = it.value();
    }
    if (payload.empty()) return;
    if (use_uvicorn_mode() && running_.load()) {
      api("PUT", "/api/agent/v1/credentials", payload);
    }
  } catch (...) {
  }
}

std::string ContentStudioSupervisor::build_cli_env_prefix() const {
  std::ostringstream prefix;
#ifdef _WIN32
  auto set_var = [&](const char* key, const std::string& value) {
    prefix << windows_env_prefix(key, value);
  };
#else
  auto set_var = [&](const char* key, const std::string& value) {
    if (value.empty()) return;
    prefix << key << "='" << value << "' ";
  };
#endif
  const std::string backend = resolve_content_studio_backend();
  const std::string gen_models = resolve_content_studio_generation_models();
#ifdef _WIN32
  std::string py_path = gen_models + ";" + backend;
#else
  std::string py_path = gen_models + ":" + backend;
#endif
  set_var("PYTHONPATH", py_path);
  set_var("OMEGA_CS_STORAGE_PATH", resolve_content_studio_storage());
  set_var("OMEGA_CS_DATA_DIR", resolve_content_studio_data_dir());
  set_var("DATABASE_URL", resolve_content_studio_database_url());
  set_var("GENERATION_MODELS_DATA_DIR", resolve_content_studio_generation_models_root());
  set_var("OMEGA_CS_JOB_SUBPROCESS", "1");
  set_var("OMEGA_CS_INVOKE", "1");
  if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT")) {
    if (rt[0]) set_var("OMEGA_RUNTIME_PORT", rt);
  } else {
    const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
    if (fs::exists(rt_state)) {
      try {
        std::ifstream in(rt_state);
        const json st = json::parse(in);
        if (st.contains("port")) {
          set_var("OMEGA_RUNTIME_PORT", std::to_string(st["port"].get<int>()));
        }
      } catch (...) {
      }
    }
  }
  if (settings_) {
    json payload = settings_->credentials_to_api_payload(settings_->load_credentials());
    const json gen = settings_->generation_to_api_payload(settings_->load_generation());
    for (auto it = gen.begin(); it != gen.end(); ++it) payload[it.key()] = it.value();
    for (auto it = payload.begin(); it != payload.end(); ++it) {
      std::string val;
      if (it.value().is_string()) {
        val = it.value().get<std::string>();
      } else if (!it.value().is_null()) {
        val = it.value().dump();
      }
      if (val.empty()) continue;
      std::string key = it.key();
      for (char& c : key) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        else if (c == '-') c = '_';
      }
      set_var(key.c_str(), val);
    }
  }
  return prefix.str();
}

std::map<std::string, std::string> ContentStudioSupervisor::studio_worker_env() const {
  std::map<std::string, std::string> env;
  const std::string backend = resolve_content_studio_backend();
  const std::string gen_models = resolve_content_studio_generation_models();
#ifdef _WIN32
  env["PYTHONPATH"] = gen_models + ";" + backend;
#else
  env["PYTHONPATH"] = gen_models + ":" + backend;
#endif
  env["OMEGA_CS_STORAGE_PATH"] = resolve_content_studio_storage();
  env["OMEGA_CS_DATA_DIR"] = resolve_content_studio_data_dir();
  env["DATABASE_URL"] = resolve_content_studio_database_url();
  env["GENERATION_MODELS_DATA_DIR"] = resolve_content_studio_generation_models_root();
  env["PYTHONUNBUFFERED"] = "1";
  env["OMEGA_CS_DISABLE_TQDM"] = "1";
  env["OMEGA_CS_IMAGE_STANDALONE_PARITY"] = "1";
  env["OMEGA_CS_WORKER"] = "1";
  env["OMEGA_CS_JOB_SUBPROCESS"] = "0";
  env["OMEGA_CS_INVOKE"] = "0";
  env["OMEGA_CS_DEFER_WORKER_SPAWN"] = "0";
  env["OMEGA_NATIVE_MEDIA"] = "0";
  env["OMEGA_CS_IMAGE_VRAM_MODE"] = "all_gpu";

  if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT")) {
    if (rt[0]) env["OMEGA_RUNTIME_PORT"] = rt;
  } else {
    const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
    if (fs::exists(rt_state)) {
      try {
        std::ifstream in(rt_state);
        const json st = json::parse(in);
        if (st.contains("port")) {
          env["OMEGA_RUNTIME_PORT"] = std::to_string(st["port"].get<int>());
        }
      } catch (...) {
      }
    }
  }

  if (settings_) {
    json payload = settings_->credentials_to_api_payload(settings_->load_credentials());
    const json gen = settings_->generation_to_api_payload(settings_->load_generation());
    if (gen.contains("imageVramMode") && gen["imageVramMode"].is_string()) {
      const std::string vram = gen["imageVramMode"].get<std::string>();
      if (!vram.empty()) env["OMEGA_CS_IMAGE_VRAM_MODE"] = vram;
    }
    for (auto it = gen.begin(); it != gen.end(); ++it) payload[it.key()] = it.value();
    for (auto it = payload.begin(); it != payload.end(); ++it) {
      std::string val;
      if (it.value().is_string()) {
        val = it.value().get<std::string>();
      } else if (!it.value().is_null()) {
        val = it.value().dump();
      }
      if (val.empty()) continue;
      std::string key = it.key();
      for (char& c : key) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
        else if (c == '-') c = '_';
      }
      env[key] = val;
    }
  }

  static const char* k_forward[] = {
      "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "TAVILY_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY",
  };
  for (const char* key : k_forward) {
    if (const char* val = std::getenv(key); val && *val) env[key] = val;
  }
  return env;
}

json ContentStudioSupervisor::invoke_cli(const std::string& command, const json& request) {
  std::lock_guard lock(invoke_cli_mu_);
  cs_log("cs_invoke " + command + " …", "info",
         json{{"command", command}, {"request_keys", request.is_object() ? request.size() : 0}});
  const std::string py = resolve_unified_python();
  const std::string backend = resolve_content_studio_backend();
  if (!fs::exists(py)) {
    cs_log("cs_invoke failed: python missing at " + py, "error");
    throw std::runtime_error("unified python venv missing — run POST /v1/python/setup first");
  }
  if (!fs::exists(backend)) {
    cs_log("cs_invoke failed: backend missing at " + backend, "error");
    throw std::runtime_error("content studio backend not found: " + backend);
  }

  const fs::path tmp_dir = fs::path(omega_home()) / "content-studio" / "tmp";
  fs::create_directories(tmp_dir);
  const std::string token = random_uuid();
  const fs::path req_path = tmp_dir / ("cs_invoke_" + command + "_" + token + "_req.json");
  const fs::path resp_path = tmp_dir / ("cs_invoke_" + command + "_" + token + "_resp.json");
  auto cleanup_paths = [&]() {
    std::error_code ec;
    fs::remove(req_path, ec);
    fs::remove(resp_path, ec);
  };
  {
    std::ofstream out(req_path);
    out << request.dump();
  }

  std::ostringstream cmd;
  cmd << build_cli_env_prefix();
#ifdef _WIN32
  cmd << "cd /d " << shell_quote_local(backend) << " && " << shell_quote_local(py) << " -m app.cli.cs_invoke "
      << command << " --request-file " << shell_quote_local(req_path.string()) << " --response-file "
      << shell_quote_local(resp_path.string());
#else
  cmd << "cd " << shell_quote_local(backend) << " && " << shell_quote_local(py) << " -m app.cli.cs_invoke "
      << command << " --request-file " << shell_quote_local(req_path.string()) << " --response-file "
      << shell_quote_local(resp_path.string()) << " 2>/dev/null";
#endif

  const std::string cmd_str = cmd.str();
  int code = -1;
  {
    auto fut = std::async(std::launch::async,
                          [&]() { return run_capture_lines(cmd_str, nullptr); });
    constexpr int k_invoke_timeout_sec = 120;
    if (fut.wait_for(std::chrono::seconds(k_invoke_timeout_sec)) != std::future_status::ready) {
      cs_log("cs_invoke " + command + " timed out after " + std::to_string(k_invoke_timeout_sec) +
                 "s",
             "error");
      cleanup_paths();
      throw std::runtime_error("cs_invoke timed out: " + command);
    }
    code = fut.get();
  }

  if (!fs::exists(resp_path)) {
    cs_log("cs_invoke " + command + " produced no response file (exit " + std::to_string(code) + ")",
           "error");
    cleanup_paths();
    throw std::runtime_error("no response file from cs_invoke " + command);
  }

  std::ifstream in(resp_path);
  if (!in) {
    cleanup_paths();
    throw std::runtime_error("failed to read cs_invoke response for " + command);
  }
  const std::string resp_text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  cleanup_paths();

  try {
    const json parsed = json::parse(resp_text);
    if (!parsed.value("ok", false)) {
      const int st = parsed.value("status", 500);
      const std::string detail = parsed.value("detail", "cs_invoke failed");
      cs_log("cs_invoke " + command + " error: " + detail, "error", json{{"status", st}});
      if (st == 404) throw std::runtime_error(detail);
      if (st == 409) throw std::runtime_error(detail);
      throw std::runtime_error(detail);
    }
    if (parsed.contains("data") && !parsed["data"].is_null()) {
      cs_log("cs_invoke " + command + " ok", "info");
      return parsed["data"];
    }
    cs_log("cs_invoke " + command + " ok (empty data)", "info");
    return json::object();
  } catch (const json::exception& e) {
    cs_log(std::string("cs_invoke ") + command + " parse error: " + e.what(), "error");
    throw std::runtime_error(std::string("failed to parse cs_invoke response: ") + e.what() +
                             (resp_text.empty() ? "" : (" — " + resp_text.substr(0, 400))));
  }
}

namespace {

std::string path_segment_after(const std::string& path, const std::string& prefix) {
  if (path.size() <= prefix.size()) return {};
  if (path.compare(0, prefix.size(), prefix) != 0) return {};
  std::string rest = path.substr(prefix.size());
  const auto q = rest.find('?');
  if (q != std::string::npos) rest = rest.substr(0, q);
  while (!rest.empty() && rest.front() == '/') rest.erase(rest.begin());
  return rest;
}

std::string query_param(const std::string& path, const std::string& key) {
  const auto qpos = path.find('?');
  if (qpos == std::string::npos) return {};
  std::string qs = path.substr(qpos + 1);
  const std::string needle = key + "=";
  const auto pos = qs.find(needle);
  if (pos == std::string::npos) return {};
  std::string val = qs.substr(pos + needle.size());
  const auto amp = val.find('&');
  if (amp != std::string::npos) val = val.substr(0, amp);
  return val;
}

#ifdef _WIN32
bool windows_pid_running(unsigned long pid) {
  if (pid == 0) return false;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return false;
  DWORD code = 0;
  const BOOL ok = GetExitCodeProcess(h, &code);
  CloseHandle(h);
  return ok && code == STILL_ACTIVE;
}
#endif

bool worker_log_has_run_job_start(const fs::path& log_path,
                                  const std::string& after_marker = {}) {
  std::ifstream in(log_path);
  if (!in) return false;
  bool past_marker = after_marker.empty();
  std::string line;
  while (std::getline(in, line)) {
    if (!past_marker) {
      if (line.find(after_marker) != std::string::npos) past_marker = true;
      continue;
    }
    if (line.find("run_job start") != std::string::npos) return true;
  }
  return false;
}

bool wait_for_worker_boot(const fs::path& log_path, unsigned long pid, int timeout_ms,
                          const std::string& spawn_marker) {
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline) {
#ifdef _WIN32
    if (!windows_pid_running(pid)) return false;
#else
    if (kill(static_cast<pid_t>(pid), 0) != 0) return false;
#endif
    if (worker_log_has_run_job_start(log_path, spawn_marker)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
#ifdef _WIN32
  return windows_pid_running(pid) && worker_log_has_run_job_start(log_path, spawn_marker);
#else
  return kill(static_cast<pid_t>(pid), 0) == 0 &&
         worker_log_has_run_job_start(log_path, spawn_marker);
#endif
}

#ifdef _WIN32
std::vector<char> merge_windows_env_block(const std::map<std::string, std::string>& overrides) {
  std::map<std::string, std::string> merged;
  if (LPCH raw = GetEnvironmentStringsA()) {
    for (const char* p = raw; *p; p += std::strlen(p) + 1) {
      const std::string entry = p;
      const auto eq = entry.find('=');
      if (eq != std::string::npos) {
        merged[entry.substr(0, eq)] = entry.substr(eq + 1);
      }
    }
    FreeEnvironmentStringsA(raw);
  }
  for (const auto& [key, val] : overrides) merged[key] = val;
  std::vector<char> block;
  block.reserve(4096);
  for (const auto& [key, val] : merged) {
    const std::string line = key + "=" + val;
    block.insert(block.end(), line.begin(), line.end());
    block.push_back('\0');
  }
  block.push_back('\0');
  return block;
}
#endif

}  // namespace

bool ContentStudioSupervisor::spawn_pipeline_worker(const std::string& job_id) {
  if (job_id.empty()) return false;
  cs_log("spawn_pipeline_worker job=" + job_id, "info");
  try {
    ensure_ready();
  } catch (const std::exception& e) {
    cs_log(std::string("spawn blocked: ensure_ready failed: ") + e.what(), "error",
           json{{"job_id", job_id}});
    return false;
  } catch (...) {
    cs_log("spawn blocked: ensure_ready failed", "error", json{{"job_id", job_id}});
    return false;
  }

  const std::string py = resolve_unified_python();
  const std::string backend = resolve_content_studio_backend();
  const fs::path log_dir = fs::path(omega_home()) / "content-studio" / "workers";
  fs::create_directories(log_dir);
  const fs::path log_path = log_dir / (job_id + ".log");
  const fs::path pid_path = log_dir / (job_id + ".pid");

  auto log_spawn = [&](const std::string& line) {
    std::ofstream log(log_path, std::ios::app);
    if (log) log << line << '\n';
  };

  if (!fs::exists(py)) {
    log_spawn("spawn failed: python not found at " + py);
    return false;
  }
  if (!fs::exists(backend)) {
    log_spawn("spawn failed: backend not found at " + backend);
    return false;
  }

  const auto env_overrides = studio_worker_env();
  {
    std::ofstream trunc(log_path, std::ios::trunc);
    if (trunc) trunc << "";
  }
  const std::string spawn_marker =
      "--- omega-runtime spawn job=" + job_id + " (direct python) ---";
  log_spawn(spawn_marker);
  log_spawn("python=" + py);
  log_spawn("backend=" + backend);
  if (env_overrides.count("PYTHONPATH")) {
    log_spawn("PYTHONPATH=" + env_overrides.at("PYTHONPATH"));
  }

#ifdef _WIN32
  HANDLE log_file =
      CreateFileA(log_path.string().c_str(), FILE_APPEND_DATA,
                  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                  nullptr);
  if (log_file == INVALID_HANDLE_VALUE) {
    log_spawn("spawn failed: could not open worker log");
    return false;
  }

  std::vector<char> env_block = merge_windows_env_block(env_overrides);
  // lpApplicationName=null: full command line (v1 Popen parity). -u for immediate log flush.
  std::string cmdline = "\"" + py + "\" -u -m app.workers.run_job " + job_id;
  std::vector<char> cmd_buf(cmdline.begin(), cmdline.end());
  cmd_buf.push_back('\0');

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = INVALID_HANDLE_VALUE;
  si.hStdOutput = log_file;
  si.hStdError = log_file;
  PROCESS_INFORMATION pi{};

  const BOOL ok =
      CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, TRUE,
                     CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, env_block.data(),
                     backend.c_str(), &si, &pi);
  CloseHandle(log_file);

  if (!ok) {
    const std::string err = "CreateProcess failed: " + std::to_string(GetLastError());
    log_spawn(err);
    cs_log(err, "error", json{{"job_id", job_id}, {"python", py}});
    return false;
  }

  {
    std::ofstream pid_out(pid_path);
    if (pid_out) pid_out << pi.dwProcessId;
  }
  log_spawn("worker pid=" + std::to_string(pi.dwProcessId));

  if (!wait_for_worker_boot(log_path, pi.dwProcessId, 15000, spawn_marker)) {
    DWORD exit_code = 0;
    if (windows_pid_running(pi.dwProcessId)) {
      TerminateProcess(pi.hProcess, 1);
      exit_code = 1;
    } else {
      GetExitCodeProcess(pi.hProcess, &exit_code);
    }
    const std::string boot_err =
        "worker exited before pipeline boot (exit_code=" + std::to_string(exit_code) + ")";
    log_spawn(boot_err + " — see log above for import/env errors");
    cs_log(boot_err, "error", json{{"job_id", job_id}, {"pid", pi.dwProcessId}});
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return false;
  }

  cs_log("worker boot ok pid=" + std::to_string(pi.dwProcessId), "info",
         json{{"job_id", job_id}});
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
#else
  const pid_t pid = fork();
  if (pid < 0) {
    log_spawn("fork failed");
    return false;
  }
  if (pid == 0) {
    for (const auto& [key, val] : env_overrides) {
      setenv(key.c_str(), val.c_str(), 1);
    }
    if (chdir(backend.c_str()) != 0) _exit(126);
    setsid();
    execl(py.c_str(), py.c_str(), "-m", "app.workers.run_job", job_id.c_str(),
          static_cast<char*>(nullptr));
    _exit(127);
  }
  {
    std::ofstream pid_out(pid_path);
    if (pid_out) pid_out << pid;
  }
  log_spawn("worker pid=" + std::to_string(pid));

  if (!wait_for_worker_boot(log_path, static_cast<unsigned long>(pid), 15000, spawn_marker)) {
    log_spawn("worker exited before pipeline boot — see log above for import/env errors");
    kill(pid, SIGTERM);
    return false;
  }
  return true;
#endif
}

json ContentStudioSupervisor::api_via_cli(const std::string& method, const std::string& path,
                                          const json& body) {
  if (method == "GET" && path == "/api/agent/v1/projects") {
    return invoke_cli("list-projects", body);
  }
  if (method == "POST" && path == "/api/agent/v1/runs") {
    cs_log("create-run queued", "info", json{{"project_id", body.value("project_id", "")},
                                             {"pipeline_mode", body.value("pipeline_mode", "")}});
    json run = invoke_cli("create-run", body);
    const std::string job_id = run.value("job_id", run.value("jobId", ""));
    if (!job_id.empty()) {
      const std::string mode = body.value("pipeline_mode", "local_media");
      const bool wants_gpu_render = mode == "local_media" || mode == "full_publish";
      if (wants_gpu_render) {
        const std::string py = resolve_unified_python();
        if (!fs::exists(py) || !content_studio_local_media_ready(py)) {
          try {
            invoke_cli("cancel-run", json{{"job_id", job_id}});
          } catch (...) {
          }
          cs_log("create-run blocked: GPU media packages missing", "error", json{{"job_id", job_id}});
          throw std::runtime_error(
              "GPU media packages (torch, TTS, diffusers) are not installed in the unified Python "
              "venv. Open Content Studio and run environment setup (installs requirements-local-media), "
              "then retry the render.");
        }
      }
      if (!spawn_pipeline_worker(job_id)) {
        try {
          invoke_cli("cancel-run", json{{"job_id", job_id}});
        } catch (...) {
        }
        cs_log("create-run spawn failed — job cancelled", "error", json{{"job_id", job_id}});
        throw std::runtime_error(
            "Pipeline job was queued but the worker process could not start. "
            "See content-studio/workers/" +
            job_id + ".log in your Omega profile folder.");
      }
      cs_log("create-run worker spawned", "info", json{{"job_id", job_id},
                                                       {"project_id", run.value("project_id", "")}});
    }
    return run;
  }
  if (method == "GET" && path.rfind("/api/agent/v1/runs/", 0) == 0) {
    const std::string id = path_segment_after(path, "/api/agent/v1/runs/");
    if (id.empty() || id.find('/') != std::string::npos) {
      throw std::runtime_error("invalid run path: " + path);
    }
    if (const auto native = get_content_studio_run_status_native(id)) return *native;
    return invoke_cli("get-run", json{{"job_id", id}});
  }
  if (method == "POST" && path.rfind("/api/agent/v1/runs/", 0) == 0 &&
      path.size() > 20 && path.substr(path.size() - 7) == "/cancel") {
    const std::string id = path_segment_after(path, "/api/agent/v1/runs/");
    const auto slash = id.find('/');
    const std::string job_id = slash == std::string::npos ? id : id.substr(0, slash);
    return invoke_cli("cancel-run", json{{"job_id", job_id}});
  }
  if (method == "POST" && path == "/api/agent/v1/gpu/unload") {
    return invoke_cli("gpu-unload", body);
  }
  if (method == "PUT" && path == "/api/agent/v1/credentials") {
    return invoke_cli("put-credentials", body);
  }
  if (method == "GET" && path.rfind("/api/agent/v1/credentials/status", 0) == 0) {
    return invoke_cli("credentials-status", json::object());
  }
  if (method == "GET" && path.rfind("/api/agent/v1/oauth/youtube/url", 0) == 0) {
    return invoke_cli("youtube-oauth-url",
                      json{{"redirect_uri", query_param(path, "redirect_uri")}});
  }
  if (method == "POST" && path == "/api/agent/v1/oauth/youtube/exchange") {
    return invoke_cli("youtube-oauth-exchange", body);
  }
  if (method == "GET" && path == "/api/agent/v1/schedules") {
    return invoke_cli("list-schedules", json::object());
  }
  if (method == "POST" && path == "/api/agent/v1/schedules") {
    return invoke_cli("create-schedule", body);
  }
  if (method == "DELETE" && path.rfind("/api/agent/v1/schedules/", 0) == 0) {
    const std::string id = path_segment_after(path, "/api/agent/v1/schedules/");
    invoke_cli("delete-schedule", json{{"schedule_id", id}});
    return json::object();
  }
  if (method == "GET" && path == "/api/agent/v1/series") {
    return invoke_cli("list-series", json::object());
  }
  if (method == "POST" && path == "/api/agent/v1/series") {
    return invoke_cli("create-series", body);
  }
  if (method == "DELETE" && path.rfind("/api/agent/v1/series/", 0) == 0) {
    const std::string id = path_segment_after(path, "/api/agent/v1/series/");
    invoke_cli("delete-series", json{{"series_id", id}});
    return json::object();
  }
  if (method == "GET" && path == "/api/social/platforms") {
    return invoke_cli("social-platforms", json::object());
  }
  if (method == "GET" && path == "/api/social/accounts") {
    return invoke_cli("social-accounts", json::object());
  }
  if (method == "GET" && path == "/api/social/posts") {
    return invoke_cli("social-posts", json::object());
  }
  if (method == "POST" && path == "/api/social/posts") {
    return invoke_cli("social-publish", body);
  }
  throw std::runtime_error("unsupported Content Studio API path (on-demand): " + method + " " + path);
}

json ContentStudioSupervisor::stop_impl() {
  std::lock_guard lock(mu_);
  ready_ = false;
#ifdef _WIN32
  if (process_handle_) {
    TerminateProcess(static_cast<HANDLE>(process_handle_), 0);
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }
#else
  if (process_pid_ > 0) {
    kill(process_pid_, SIGTERM);
    int status = 0;
    for (int i = 0; i < 20; ++i) {
      const pid_t r = waitpid(process_pid_, &status, WNOHANG);
      if (r == process_pid_ || r == -1) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (waitpid(process_pid_, &status, WNOHANG) == 0) {
      kill(process_pid_, SIGKILL);
      waitpid(process_pid_, &status, 0);
    }
    process_pid_ = 0;
  }
#endif
  running_ = false;
  port_ = 0;
  return status_locked();
}

json ContentStudioSupervisor::start() {
  std::lock_guard lock(start_mu_);
  return start_impl();
}

json ContentStudioSupervisor::ensure_ready_impl() {
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    throw std::runtime_error("unified python venv missing — run POST /v1/python/setup first");
  }
  const std::string backend = resolve_content_studio_backend();
  if (!fs::exists(backend)) {
    throw std::runtime_error("content studio backend not found: " + backend);
  }
  if (!content_studio_stack_import_ok(py, backend)) {
    const int pip_code = install_content_studio_stack(py);
    if (pip_code != 0 || !content_studio_stack_import_ok(py, backend)) {
      std::string import_err;
      run_capture_lines(python_run_in_backend(py, backend, "from app.database import SessionLocal"),
                        [&](const std::string& line) {
                          if (!import_err.empty()) import_err += "\n";
                          import_err += line;
                        });
      throw std::runtime_error(
          "Content Studio dependencies are incomplete (sqlalchemy and related packages). "
          "Automatic pip repair failed — run environment setup from Content Studio again. "
          "Detail: " +
          (import_err.empty() ? "app.database import failed" : import_err));
    }
  }

  const fs::path data_root = fs::path(omega_home()) / "content-studio";
  fs::create_directories(data_root);
  fs::create_directories(data_root / "tmp");
  fs::create_directories(data_root / "workers");
  fs::create_directories(fs::path(resolve_content_studio_data_dir()));
  const std::string storage = resolve_content_studio_storage();
  fs::create_directories(storage);
  fs::create_directories(resolve_content_studio_generation_models_root());

  {
    const fs::path script = fs::path(backend) / "scripts" / "run_db_migrations.py";
    if (fs::exists(script)) {
      std::string migrate_err;
      std::ostringstream cmd;
      cmd << build_cli_env_prefix();
#ifdef _WIN32
      cmd << "cd /d " << shell_quote_local(backend) << " && ";
#else
      cmd << "cd " << shell_quote_local(backend) << " && ";
#endif
      cmd << shell_quote_local(py) << " " << shell_quote_local(script.string()) << " 2>&1";
      const int migrate_code = run_capture_lines(cmd.str(), [&](const std::string& line) {
        if (!migrate_err.empty()) migrate_err += "\n";
        migrate_err += line;
      });
      if (migrate_code != 0) {
        throw std::runtime_error(
            "Content Studio database migration failed. "
            "Run Python setup again, then retry. "
            "Detail: " +
            (migrate_err.empty() ? "alembic upgrade failed" : migrate_err));
      }
    }
  }

  {
    std::lock_guard lock(mu_);
    ready_ = true;
    running_ = true;
    last_error_.clear();
  }
  cs_log("content studio ready (on-demand)", "info");
  return status();
}

void ContentStudioSupervisor::ensure_ready() {
  std::lock_guard lock(start_mu_);
  if (ready_.load()) return;
  ensure_ready_impl();
}

json ContentStudioSupervisor::start_impl() {
  if (!use_uvicorn_mode()) {
    return ensure_ready_impl();
  }

  stop_impl();
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    throw std::runtime_error("unified python venv missing — run POST /v1/python/setup first");
  }
  const std::string backend = resolve_content_studio_backend();
  if (!fs::exists(backend)) {
    throw std::runtime_error("content studio backend not found: " + backend);
  }
  if (!content_studio_app_import_ok(py, backend)) {
    const int pip_code = install_content_studio_stack(py);
    if (pip_code != 0 || !content_studio_app_import_ok(py, backend)) {
      std::string import_err;
      run_capture_lines(python_run_in_backend(py, backend, "from app.main import app"),
                        [&](const std::string& line) {
                          if (!import_err.empty()) import_err += "\n";
                          import_err += line;
                        });
      throw std::runtime_error(
          "Content Studio API dependencies are incomplete (sqlalchemy and related packages). "
          "Automatic pip repair failed — run environment setup from Content Studio again. "
          "Detail: " +
          (import_err.empty() ? "app.main import failed" : import_err));
    }
  }

  const fs::path data_root = fs::path(omega_home()) / "content-studio";
  fs::create_directories(data_root);
  fs::create_directories(fs::path(resolve_content_studio_data_dir()));

  {
    const fs::path script = fs::path(backend) / "scripts" / "run_db_migrations.py";
    if (fs::exists(script)) {
      std::string migrate_err;
      std::ostringstream cmd;
      cmd << build_cli_env_prefix();
#ifdef _WIN32
      cmd << "cd /d " << shell_quote_local(backend) << " && ";
#else
      cmd << "cd " << shell_quote_local(backend) << " && ";
#endif
      cmd << shell_quote_local(py) << " " << shell_quote_local(script.string()) << " 2>&1";
      const int migrate_code = run_capture_lines(cmd.str(), [&](const std::string& line) {
        if (!migrate_err.empty()) migrate_err += "\n";
        migrate_err += line;
      });
      if (migrate_code != 0) {
        throw std::runtime_error(
            "Content Studio database migration failed. "
            "Run Python setup again, then restart Content Studio. "
            "Detail: " +
            (migrate_err.empty() ? "alembic upgrade failed" : migrate_err));
      }
    }
  }

  const int port = pick_free_port();
  fs::create_directories(data_root);
  const fs::path log_dir = data_root / "logs";
  fs::create_directories(log_dir);
  const fs::path uvicorn_log = log_dir / "uvicorn.log";
  try {
    std::ofstream append(uvicorn_log, std::ios::app);
    append << "\n--- omega content studio start ---\n";
  } catch (...) {
  }
  const std::string storage = resolve_content_studio_storage();
  fs::create_directories(storage);

#ifdef _WIN32
  const std::string uvicorn_cmd = shell_quote_local(py) + " -m uvicorn app.main:app --host 127.0.0.1 --port " +
                                  std::to_string(port);
  const std::string cmd =
      "cmd /c cd /d " + shell_quote_local(backend) + " && " + uvicorn_cmd + " 1>> " +
      shell_quote_local(uvicorn_log.string()) + " 2>&1";
  _putenv_s("OMEGA_CS_STORAGE_PATH", storage.c_str());
  _putenv_s("OMEGA_CS_DATA_DIR", resolve_content_studio_data_dir().c_str());
  _putenv_s("DATABASE_URL", resolve_content_studio_database_url().c_str());
  if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT")) {
    if (rt[0]) _putenv_s("OMEGA_RUNTIME_PORT", rt);
  } else {
    const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
    if (fs::exists(rt_state)) {
      try {
        std::ifstream in(rt_state);
        const json st = json::parse(in);
        if (st.contains("port")) {
          _putenv_s("OMEGA_RUNTIME_PORT", std::to_string(st["port"].get<int>()).c_str());
        }
      } catch (...) {
      }
    }
  }
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<char> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back('\0');
  if (!CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      backend.c_str(), &si, &pi)) {
    throw std::runtime_error("failed to start content studio uvicorn");
  }
  CloseHandle(pi.hThread);
  {
    std::lock_guard lock(mu_);
    process_handle_ = pi.hProcess;
    port_ = port;
    running_ = false;
    last_error_.clear();
  }
#else
  const pid_t child = fork();
  if (child < 0) {
    throw std::runtime_error("failed to fork content studio process");
  }
  if (child == 0) {
    if (chdir(backend.c_str()) != 0) _exit(127);
    setenv("OMEGA_CS_STORAGE_PATH", storage.c_str(), 1);
    setenv("OMEGA_CS_DATA_DIR", resolve_content_studio_data_dir().c_str(), 1);
    setenv("DATABASE_URL", resolve_content_studio_database_url().c_str(), 1);
    if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT")) {
      if (rt[0]) setenv("OMEGA_RUNTIME_PORT", rt, 1);
    } else {
      const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
      if (fs::exists(rt_state)) {
        try {
          std::ifstream in(rt_state);
          const json st = json::parse(in);
          if (st.contains("port")) {
            setenv("OMEGA_RUNTIME_PORT", std::to_string(st["port"].get<int>()).c_str(), 1);
          }
        } catch (...) {
        }
      }
    }
    const std::string port_str = std::to_string(port);
    execl(py.c_str(), py.c_str(), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
          "--port", port_str.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }
  {
    std::lock_guard lock(mu_);
    process_pid_ = static_cast<int>(child);
    port_ = port;
    running_ = false;
    last_error_.clear();
  }
#endif

  if (!wait_ready(port, 300000)) {
#ifdef _WIN32
    DWORD exit_code = STILL_ACTIVE;
    {
      std::lock_guard lock(mu_);
      exit_code = process_exit_code(process_handle_);
    }
#endif
    const std::string tail = read_tail_file(uvicorn_log);
    stop_impl();
    std::string msg =
        "Content Studio API did not become ready in time (first launch can take a few minutes)";
#ifdef _WIN32
    if (exit_code != STILL_ACTIVE) {
      msg += " — uvicorn exited (code " + std::to_string(exit_code) + ")";
    }
#endif
    if (!tail.empty()) {
      msg += ". Log tail (~/.omega/content-studio/logs/uvicorn.log): " + tail;
    } else {
      msg += ". See ~/.omega/content-studio/logs/uvicorn.log";
    }
    throw std::runtime_error(msg);
  }
  {
    std::lock_guard lock(mu_);
    running_ = true;
  }
  sync_settings_to_api();
  return status();
}

json ContentStudioSupervisor::stop() {
  std::lock_guard lock(start_mu_);
  return stop_impl();
}

json ContentStudioSupervisor::restart() {
  std::lock_guard lock(start_mu_);
  stop_impl();
  return start_impl();
}

void ContentStudioSupervisor::ensure_started() {
  std::lock_guard lock(start_mu_);
  if (!use_uvicorn_mode()) {
    if (!ready_.load()) ensure_ready_impl();
    return;
  }
  if (running_.load()) {
    std::lock_guard state_lock(mu_);
    if (is_process_alive_locked() && probe_api_health(port_)) return;
  }
  start_impl();
}

json ContentStudioSupervisor::api(const std::string& method, const std::string& path,
                                  const json& body) {
  if (!use_uvicorn_mode()) {
    if (!ready_.load()) {
      std::lock_guard lock(start_mu_);
      if (!ready_.load()) ensure_ready_impl();
    }
    return api_via_cli(method, path, body);
  }
  const int port = port_or_throw();
  httplib::Client cli("127.0.0.1", port);
  cli.set_connection_timeout(30, 0);
  cli.set_read_timeout(600, 0);
  const httplib::Headers headers = {{"Content-Type", "application/json"}};
  const std::string body_str = body.is_null() || body.empty() ? std::string{} : body.dump();

  if (method == "GET") {
    return parse_api_response(cli.Get(path.c_str()), path);
  }
  if (method == "POST") {
    return parse_api_response(cli.Post(path.c_str(), headers, body_str, "application/json"), path);
  }
  if (method == "PUT") {
    return parse_api_response(cli.Put(path.c_str(), headers, body_str, "application/json"), path);
  }
  if (method == "DELETE") {
    return parse_api_response(cli.Delete(path.c_str()), path);
  }
  throw std::runtime_error("unsupported HTTP method: " + method);
}

json ContentStudioSupervisor::cancel_run(const std::string& job_id) {
  ensure_started();
  return api("POST", "/api/agent/v1/runs/" + job_id + "/cancel");
}

bool ContentStudioSupervisor::wait_for_pipeline_idle(int timeout_ms) {
  const int step_ms = 250;
  int elapsed = 0;
  while (elapsed < timeout_ms) {
    if (is_content_studio_pipeline_idle_native()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(step_ms));
    elapsed += step_ms;
  }
  return false;
}

json ContentStudioSupervisor::force_stop_job(const json& opts) {
  const std::string job_id = opts.value("jobId", "");
  if (job_id.empty() || job_id == "failed") {
    return json{{"ok", false}, {"message", "No active job to stop"}};
  }
  try {
    cancel_run(job_id);
    try {
      api("POST", "/api/agent/v1/gpu/unload", json{{"reason", "user_stop"}});
    } catch (...) {
    }
    return json{{"ok", true},
                {"phase", "cancelled"},
                {"message", "Generation stopped. GPU memory was released; you can start another render."}};
  } catch (const std::exception& e) {
    try {
      api("POST", "/api/agent/v1/gpu/unload", json{{"reason", "user_stop"}});
      return json{{"ok", true},
                  {"phase", "cancelled"},
                  {"message", "Stop requested — local GPU unload attempted."}};
    } catch (...) {
      return json{{"ok", false}, {"message", e.what()}};
    }
  }
}

json ContentStudioSupervisor::connect_youtube_oauth(EventBus& events, ContentStudioSettings& settings) {
  json creds = settings.load_credentials();
  const std::string client_id = creds.value("youtubeClientId", "");
  const std::string client_secret = creds.value("youtubeClientSecret", "");
  if (client_id.empty() || client_secret.empty()) {
    throw std::runtime_error("Set YouTube Client ID and Client Secret in Content Studio credentials first.");
  }

  ensure_started();
  const int oauth_port = 8765;
  const std::string redirect_uri =
      creds.value("youtubeOAuthRedirectUri", "http://127.0.0.1:" + std::to_string(oauth_port) + "/oauth2callback");

  std::string auth_code;
  std::exception_ptr callback_err;
  httplib::Server oauth_srv;
  oauth_srv.Get("/oauth2callback", [&](const httplib::Request& req, httplib::Response& res) {
    const auto err = req.get_param_value("error");
    if (!err.empty()) {
      res.set_content("<h1>OAuth error</h1>", "text/html");
      callback_err = std::make_exception_ptr(std::runtime_error(err));
      oauth_srv.stop();
      return;
    }
    auth_code = req.get_param_value("code");
    res.set_content(
        "<html><body style=\"font-family:sans-serif;background:#111;color:#eee;padding:2rem\">"
        "<h1>YouTube connected</h1><p>Return to Omega.</p></body></html>",
        "text/html");
    oauth_srv.stop();
  });

  std::thread oauth_thread([&] { oauth_srv.listen("127.0.0.1", oauth_port); });

  const json url_resp =
      api("GET", "/api/agent/v1/oauth/youtube/url?redirect_uri=" + redirect_uri, json::object());
  const std::string auth_url = url_resp.value("url", "");
  if (auth_url.empty()) {
    oauth_srv.stop();
    oauth_thread.join();
    throw std::runtime_error("Content Studio did not return YouTube OAuth URL");
  }

  events.publish("omega:content-studio:changed",
                 json{{"phase", "youtube_oauth"}, {"authUrl", auth_url}, {"redirectUri", redirect_uri}});

#ifdef _WIN32
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, auth_url.c_str(), -1, nullptr, 0);
  std::wstring wurl(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, auth_url.c_str(), -1, wurl.data(), wlen);
  if (!wurl.empty() && wurl.back() == L'\0') wurl.pop_back();
  ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
#else
  ShellBridge shell;
  shell.post("/v1/shell/open-url", json{{"url", auth_url}});
#endif

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(5);
  while (auth_code.empty() && !callback_err && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  oauth_srv.stop();
  if (oauth_thread.joinable()) oauth_thread.join();
  if (callback_err) std::rethrow_exception(callback_err);
  if (auth_code.empty()) throw std::runtime_error("YouTube OAuth timed out (5 minutes)");

  const json exchanged = api("POST", "/api/agent/v1/oauth/youtube/exchange",
                             json{{"code", auth_code}, {"redirect_uri", redirect_uri}});
  const std::string refresh = exchanged.value("refresh_token", "");
  if (refresh.empty()) throw std::runtime_error("YouTube exchange did not return refresh_token");

  creds["youtubeRefreshToken"] = refresh;
  settings.save_credentials(creds);
  sync_settings_to_api();
  return json{{"refreshToken", refresh}, {"authUrl", auth_url}};
}

json ContentStudioSupervisor::download_generation_model(const json& req, EventBus& events) {
  std::string kind = "tts";
  if (req.is_array() && !req.empty() && req[0].is_string()) kind = req[0].get<std::string>();
  else if (req.contains("kind") && req["kind"].is_string()) kind = req["kind"].get<std::string>();

  std::string repo_id;
  if (req.is_array() && req.size() > 1 && req[1].is_string()) repo_id = req[1].get<std::string>();
  else repo_id = req.value("repoId", req.value("repo", ""));
  if (repo_id.empty()) throw std::runtime_error("repoId is required");

  const std::string script = resolve_content_studio_download_script();
  if (!fs::exists(script)) {
    throw std::runtime_error("Content Studio download script missing: " + script);
  }

  const std::string gen_models = resolve_content_studio_generation_models();
  if (gen_models.empty()) {
    throw std::runtime_error(
        "Content Studio generation_models folder missing (expected localgen/ next to backend)");
  }

  const fs::path models_root = fs::path(resolve_content_studio_generation_models_root());
  fs::create_directories(models_root);

  std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    ensure_ready();
    py = resolve_unified_python();
  }
  if (!fs::exists(py)) {
    throw std::runtime_error("Python venv missing — run Settings → Python setup or POST /v1/python/setup");
  }

  std::string stack_err;
  if (!generation_download_stack_ready(py, gen_models, &stack_err)) {
    const int pip_code = install_content_studio_stack(py);
    if (pip_code != 0 || !generation_download_stack_ready(py, gen_models, &stack_err)) {
      throw std::runtime_error(
          "Content Studio download stack not ready (install huggingface_hub/localgen). "
          "Run Settings → Python setup with the content profile, then retry. "
          + stack_err);
    }
  }

  std::string label;
  if (req.is_array() && req.size() > 2 && req[2].is_string()) label = req[2].get<std::string>();
  else if (req.contains("label") && req["label"].is_string()) label = req["label"].get<std::string>();

  std::string size_hint;
  if (req.is_array() && req.size() > 3 && req[3].is_string()) size_hint = req[3].get<std::string>();
  else if (req.contains("sizeHint") && req["sizeHint"].is_string()) size_hint = req["sizeHint"].get<std::string>();
  else if (req.contains("size") && req["size"].is_string()) size_hint = req["size"].get<std::string>();
  const uint64_t expected_bytes = parse_size_hint_bytes(size_hint);

  const fs::path dest =
      kind == "image_adapter"
          ? models_root / "image-adapters" / std::regex_replace(repo_id, std::regex("/"), "__")
          : models_root / kind / std::regex_replace(repo_id, std::regex("/"), "__");

  std::ostringstream cmd;
#ifdef _WIN32
  cmd << windows_env_prefix("PYTHONPATH", gen_models);
  cmd << windows_env_prefix("GENERATION_MODELS_DATA_DIR", models_root.string());
  cmd << windows_env_prefix("PYTHONUNBUFFERED", "1");
  cmd << "\"" << py << "\" -u \"" << script << "\" " << kind << " \"" << repo_id << "\" \""
      << models_root.string() << "\"";
#else
  cmd << "PYTHONPATH=" << shell_quote_local(gen_models) << " ";
  cmd << "GENERATION_MODELS_DATA_DIR=" << shell_quote_local(models_root.string()) << " ";
  cmd << "PYTHONUNBUFFERED=1 ";
  cmd << shell_quote_local(py) << " -u " << shell_quote_local(script) << " " << kind << " "
      << shell_quote_local(repo_id) << " " << shell_quote_local(models_root.string());
#endif
  if (!label.empty()) cmd << " --label " << shell_quote_local(label);
  cmd << " 2>&1";

  {
    std::lock_guard lock(g_generation_download_mu);
    if (g_generation_download_active.count(repo_id)) {
      return json{{"accepted", true},
                  {"async", true},
                  {"alreadyRunning", true},
                  {"repoId", repo_id},
                  {"kind", kind}};
    }
    g_generation_download_active.insert(repo_id);
  }

  const std::string cmd_str = cmd.str();
  std::thread([repo_id, dest, cmd_str, expected_bytes, &events]() {
    run_generation_download_job(repo_id, dest, cmd_str, expected_bytes, events);
    std::lock_guard lock(g_generation_download_mu);
    g_generation_download_active.erase(repo_id);
  }).detach();

  return json{{"accepted", true}, {"async", true}, {"repoId", repo_id}, {"kind", kind},
              {"dest", dest.string()}};
}

}  // namespace omega::runtime
