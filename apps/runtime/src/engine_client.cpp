#include "omega/runtime/engine_client.hpp"

#include "omega/runtime/json_safe.hpp"
#include "omega/runtime/paths.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <iostream>
#include <mutex>
#include <random>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <unordered_set>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string random_id() {
  static std::mt19937 rng{std::random_device{}()};
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(32);
  for (int i = 0; i < 32; ++i) out.push_back(hex[rng() % 16]);
  return out;
}

#ifdef _WIN32
bool write_all(HANDLE handle, const std::string& data) {
  size_t offset = 0;
  while (offset < data.size()) {
    DWORD written = 0;
    const DWORD chunk =
        static_cast<DWORD>(std::min<size_t>(data.size() - offset, 65536));
    if (!WriteFile(handle, data.data() + offset, chunk, &written, nullptr) || written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

std::wstring widen_utf8(const std::string& s) {
  if (s.empty()) return L"";
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

std::string getenv_str(const char* name) {
  const char* v = std::getenv(name);
  return v ? std::string(v) : std::string();
}

HANDLE open_engine_stderr_log(const SECURITY_ATTRIBUTES& sa) {
  const std::wstring log_path = widen_utf8(resolve_engine_stderr_log());
  HANDLE file = CreateFileW(log_path.c_str(), FILE_APPEND_DATA,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, const_cast<SECURITY_ATTRIBUTES*>(&sa),
                            OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) return file;
  append_load_diagnostic("engine stderr log unavailable at " + resolve_engine_stderr_log() +
                         " (GetLastError=" + std::to_string(GetLastError()) + ")");
  return CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                     const_cast<SECURITY_ATTRIBUTES*>(&sa), OPEN_EXISTING, 0, nullptr);
}

std::string describe_win_exit_code(DWORD code) {
  if (code == STILL_ACTIVE) return "running";
  std::string msg = "exit code " + std::to_string(code);
  if (code == 3221225781u || code == static_cast<DWORD>(0xC0000135)) {
    msg += " (missing DLL — install Microsoft Visual C++ 2015–2022 Redistributable x64)";
  } else if (code == 3221226505u || code == static_cast<DWORD>(0xC0000142)) {
    msg += " (application failed to initialize)";
  }
  return msg;
}

bool wait_for_engine_process_alive(HANDLE proc, std::string& error_out) {
  for (int i = 0; i < 40; ++i) {
    DWORD code = STILL_ACTIVE;
    if (!GetExitCodeProcess(proc, &code) || code != STILL_ACTIVE) {
      error_out = "omega-engine exited during startup (" + describe_win_exit_code(code) + ")";
      append_load_diagnostic(error_out);
      return false;
    }
    Sleep(25);
  }
  return true;
}
#else
bool write_all(int fd, const std::string& data) {
  size_t offset = 0;
  while (offset < data.size()) {
    const ssize_t n =
        write(fd, data.data() + offset, static_cast<ssize_t>(data.size() - offset));
    if (n <= 0) return false;
    offset += static_cast<size_t>(n);
  }
  return true;
}
#endif

}  // namespace

struct EngineClient::Impl {
  /** Serializes engine spawn, restart, and teardown. */
  std::mutex start_mu;
  /** Serializes all stdin writes (prevents JSON-line corruption). */
  std::mutex io_mu;
  mutable std::mutex mu;
  std::string last_error;
  bool started = false;

  struct ChatSlot {
    ChatTokenCallback on_token;
    ChatMetricsCallback on_metrics;
    json result = json::object();
    bool finished = false;
    bool failed = false;
    std::string error;
  };

  std::thread reader;
  std::atomic<bool> reader_stop{false};
  std::unordered_map<std::string, json> responses;
  std::unordered_set<std::string> pending_commands;
  std::unordered_map<std::string, ChatSlot> chat_slots;
  std::condition_variable cv;
  EngineEventCallback event_handler;
  std::function<void(const std::string&)> failure_handler;
  std::atomic<bool> process_dead{false};

#ifdef _WIN32
  HANDLE proc = nullptr;
  HANDLE stdin_write = nullptr;
  HANDLE stdout_read = nullptr;
#else
  pid_t proc = -1;
  int stdin_write = -1;
  int stdout_read = -1;
#endif
};

EngineClient::EngineClient() : impl_(new Impl()) {}

void EngineClient::set_event_handler(EngineEventCallback handler) {
  std::lock_guard lock(impl_->mu);
  impl_->event_handler = std::move(handler);
}

void EngineClient::set_failure_handler(std::function<void(const std::string& reason)> handler) {
  std::lock_guard lock(impl_->mu);
  impl_->failure_handler = std::move(handler);
}

void EngineClient::notify_process_exited(const std::string& reason) {
  append_load_diagnostic("engine process exit: " + reason);
  std::function<void(const std::string&)> failure_cb;
  {
    std::lock_guard lock(impl_->mu);
    if (impl_->process_dead.exchange(true)) return;
    impl_->started = false;
    const std::string detail =
        reason.find("reload") != std::string::npos
            ? reason
            : reason + " (reload the model in Models, then retry)";
    impl_->last_error = detail;
    for (auto& [id, slot] : impl_->chat_slots) {
      if (!slot.finished) {
        slot.failed = true;
        slot.error = detail;
      }
    }
    for (const auto& pending_id : impl_->pending_commands) {
      if (impl_->responses.find(pending_id) == impl_->responses.end()) {
        impl_->responses[pending_id] =
            json{{"id", pending_id}, {"success", false}, {"error", detail}};
      }
    }
    impl_->pending_commands.clear();
    failure_cb = impl_->failure_handler;
    impl_->cv.notify_all();
  }
  if (failure_cb) failure_cb(reason);
}

void EngineClient::shutdown_process_handles() {
  impl_->reader_stop.store(true);
#ifdef _WIN32
  if (impl_->stdin_write) {
    CloseHandle(impl_->stdin_write);
    impl_->stdin_write = nullptr;
  }
  if (impl_->proc) {
    TerminateProcess(impl_->proc, 1);
    WaitForSingleObject(impl_->proc, 5000);
    CloseHandle(impl_->proc);
    impl_->proc = nullptr;
  }
  if (impl_->stdout_read) {
    CloseHandle(impl_->stdout_read);
    impl_->stdout_read = nullptr;
  }
#else
  if (impl_->stdin_write >= 0) {
    close(impl_->stdin_write);
    impl_->stdin_write = -1;
  }
  if (impl_->proc > 0) {
    kill(impl_->proc, SIGTERM);
    int status = 0;
    waitpid(impl_->proc, &status, 0);
    impl_->proc = -1;
  }
  if (impl_->stdout_read >= 0) {
    close(impl_->stdout_read);
    impl_->stdout_read = -1;
  }
#endif
  if (impl_->reader.joinable()) impl_->reader.join();
  impl_->reader_stop.store(false);
  impl_->process_dead.store(false);
  impl_->started = false;
}

EngineClient::~EngineClient() {
  impl_->reader_stop.store(true);
#ifdef _WIN32
  if (impl_->reader.joinable()) {
    if (impl_->stdin_write) CloseHandle(impl_->stdin_write);
    impl_->reader.join();
  }
  if (impl_->stdout_read) CloseHandle(impl_->stdout_read);
  if (impl_->proc) {
    TerminateProcess(impl_->proc, 0);
    CloseHandle(impl_->proc);
  }
#else
  if (impl_->reader.joinable()) {
    if (impl_->stdin_write >= 0) close(impl_->stdin_write);
    impl_->reader.join();
  }
  if (impl_->stdout_read >= 0) close(impl_->stdout_read);
  if (impl_->proc > 0) {
    kill(impl_->proc, SIGTERM);
    int status = 0;
    waitpid(impl_->proc, &status, 0);
  }
#endif
  delete impl_;
}

bool EngineClient::available() const {
  if (!impl_->started || impl_->process_dead.load()) return false;
#ifdef _WIN32
  if (!impl_->proc) return false;
  DWORD code = 0;
  if (!GetExitCodeProcess(impl_->proc, &code) || code != STILL_ACTIVE) return false;
  return true;
#else
  if (impl_->proc <= 0) return false;
  return kill(impl_->proc, 0) == 0;
#endif
}

std::string EngineClient::last_error() const {
  std::lock_guard lock(impl_->mu);
  return impl_->last_error;
}

void EngineClient::ingest_line(const std::string& line) {
  if (line.empty()) return;
  try {
    json parsed = json::parse(line);
    if (parsed.contains("event")) {
      const std::string event = parsed.value("event", "");
      json payload = parsed.contains("payload") ? parsed["payload"] : json::object();

      EngineEventCallback handler;
      {
        std::lock_guard lock(impl_->mu);
        handler = impl_->event_handler;
      }
      if (handler && (event == "ModelLoaded" || event == "ModelUnloaded" ||
                      event == "ModelLoadProgress")) {
        handler(event, payload);
      }

      const std::string session_id = payload.value("sessionId", "");
      if (session_id.empty()) return;

      std::lock_guard lock(impl_->mu);
      const auto it = impl_->chat_slots.find(session_id);
      if (it == impl_->chat_slots.end()) return;

      if (event == "ChatChunkReceived") {
        const std::string text = payload.value("text", "");
        const int index = payload.value("index", 0);
        if (it->second.on_metrics &&
            (payload.value("measured", false) || payload.contains("prompt_ms") ||
             payload.contains("gen_ms") || payload.contains("prompt_tokens") ||
             payload.contains("completion_tokens"))) {
          it->second.on_metrics(payload);
        }
        if (it->second.on_token && !text.empty()) {
          it->second.on_token(text, index);
        }
      } else if (event == "ChatFinished") {
        json result{{"text", payload.value("text", "")}};
        if (payload.contains("tokens_in")) result["tokens_in"] = payload["tokens_in"];
        if (payload.contains("tokens_out")) result["tokens_out"] = payload["tokens_out"];
        if (payload.contains("prompt_ms")) result["prompt_ms"] = payload["prompt_ms"];
        if (payload.contains("gen_ms")) result["gen_ms"] = payload["gen_ms"];
        it->second.result = std::move(result);
        it->second.finished = true;
        impl_->cv.notify_all();
      } else if (event == "ChatError") {
        it->second.failed = true;
        it->second.error = payload.value("error", "engine chat error");
        impl_->cv.notify_all();
      }
      return;
    }

    const std::string id = parsed.value("id", "");
    if (id.empty()) return;

    std::lock_guard lock(impl_->mu);
    const auto chat_it = impl_->chat_slots.find(id);
    if (chat_it != impl_->chat_slots.end()) {
      if (!parsed.value("success", false)) {
        chat_it->second.failed = true;
        chat_it->second.error = parsed.value("error", "engine chat error");
        impl_->cv.notify_all();
        return;
      }
      if (parsed.contains("data") && parsed["data"].is_object()) {
        const json& data = parsed["data"];
        if (data.contains("text")) chat_it->second.result = data;
      }
      chat_it->second.finished = true;
      impl_->cv.notify_all();
      return;
    }

    impl_->responses[id] = parsed;
    impl_->pending_commands.erase(id);
    impl_->cv.notify_all();
  } catch (...) {
  }
}

void EngineClient::stop() {
  std::lock_guard start_lock(impl_->start_mu);
  shutdown_process_handles();
}

bool EngineClient::ensure_started() {
  std::lock_guard start_lock(impl_->start_mu);
  if (available()) return true;

  if (impl_->started || impl_->process_dead.load()) {
    shutdown_process_handles();
  }

  const std::string bin = resolve_engine_binary();
  if (!std::filesystem::exists(bin)) {
    std::lock_guard lock(impl_->mu);
    impl_->last_error = "omega-engine not found: " + bin;
    append_load_diagnostic(impl_->last_error);
    return false;
  }

#ifdef _WIN32
  const std::filesystem::path infer_dll =
      std::filesystem::path(bin).parent_path() / "omega_infer.dll";
  if (!std::filesystem::exists(infer_dll)) {
    std::lock_guard lock(impl_->mu);
    impl_->last_error = "omega_infer.dll missing next to omega-engine: " + infer_dll.string();
    append_load_diagnostic(impl_->last_error);
    return false;
  }
#endif

#ifdef _WIN32
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE stdin_read = nullptr;
  HANDLE stdout_write = nullptr;
  if (!CreatePipe(&stdin_read, &impl_->stdin_write, &sa, 0)) {
    impl_->last_error = "CreatePipe stdin failed";
    return false;
  }
  if (!CreatePipe(&impl_->stdout_read, &stdout_write, &sa, 0)) {
    CloseHandle(stdin_read);
    CloseHandle(impl_->stdin_write);
    impl_->stdin_write = nullptr;
    impl_->last_error = "CreatePipe stdout failed";
    return false;
  }

  SetHandleInformation(impl_->stdin_write, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(impl_->stdout_read, HANDLE_FLAG_INHERIT, 0);

  const std::string engine_dir = std::filesystem::path(bin).parent_path().string();
  HANDLE stderr_file = open_engine_stderr_log(sa);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdInput = stdin_read;
  si.hStdOutput = stdout_write;
  si.hStdError = stderr_file;

  PROCESS_INFORMATION pi{};
  const std::string models = models_dir();
  const std::wstring cmd = L"\"" + widen_utf8(bin) + L"\" --models-dir \"" + widen_utf8(models) + L"\"";
  std::vector<wchar_t> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back(L'\0');

  const std::wstring wcwd = widen_utf8(engine_dir);
  const std::filesystem::path bin_dir =
      std::filesystem::path(bin).parent_path().parent_path() / "bin";
  std::wstring prev_omega_bin;
  if (std::filesystem::is_directory(bin_dir)) {
    prev_omega_bin = widen_utf8(getenv_str("OMEGA_BIN_DIR"));
    _wputenv((L"OMEGA_BIN_DIR=" + widen_utf8(bin_dir.string())).c_str());
  }
  if (!CreateProcessW(nullptr, cmd_buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                      wcwd.empty() ? nullptr : wcwd.c_str(), &si, &pi)) {
    if (std::filesystem::is_directory(bin_dir)) {
      if (prev_omega_bin.empty()) {
        _wputenv(L"OMEGA_BIN_DIR=");
      } else {
        _wputenv((L"OMEGA_BIN_DIR=" + prev_omega_bin).c_str());
      }
    }
    CloseHandle(stdin_read);
    CloseHandle(stdout_write);
    CloseHandle(stderr_file);
    CloseHandle(impl_->stdin_write);
    CloseHandle(impl_->stdout_read);
    impl_->stdin_write = nullptr;
    impl_->stdout_read = nullptr;
    impl_->last_error = "CreateProcess failed for omega-engine (code " + std::to_string(GetLastError()) + ")";
    append_load_diagnostic(impl_->last_error + " bin=" + bin + " models=" + models);
    return false;
  }

  append_load_diagnostic("spawned omega-engine pid=" + std::to_string(pi.dwProcessId) + " bin=" + bin +
                         " models=" + models);

  CloseHandle(stdin_read);
  CloseHandle(stdout_write);
  CloseHandle(stderr_file);
  CloseHandle(pi.hThread);
  impl_->proc = pi.hProcess;
#else
  int stdin_pipe[2]{-1, -1};
  int stdout_pipe[2]{-1, -1};
  if (pipe(stdin_pipe) != 0 || pipe(stdout_pipe) != 0) {
    std::lock_guard lock(impl_->mu);
    impl_->last_error = "pipe() failed for omega-engine";
    return false;
  }

  fcntl(stdin_pipe[1], F_SETFD, FD_CLOEXEC);
  fcntl(stdout_pipe[0], F_SETFD, FD_CLOEXEC);

  const std::string models = models_dir();
  const std::string engine_dir = std::filesystem::path(bin).parent_path().string();
  const std::string stderr_log = resolve_engine_stderr_log();
  const pid_t child = fork();
  if (child < 0) {
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    std::lock_guard lock(impl_->mu);
    impl_->last_error = "fork() failed for omega-engine";
    return false;
  }

  if (child == 0) {
    if (!engine_dir.empty()) {
      std::error_code ec;
      std::filesystem::current_path(engine_dir, ec);
    }
    const int err_fd = ::open(stderr_log.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (err_fd >= 0) {
      dup2(err_fd, STDERR_FILENO);
      close(err_fd);
    }
    dup2(stdin_pipe[0], STDIN_FILENO);
    dup2(stdout_pipe[1], STDOUT_FILENO);
    close(stdin_pipe[0]);
    close(stdin_pipe[1]);
    close(stdout_pipe[0]);
    close(stdout_pipe[1]);
    execl(bin.c_str(), bin.c_str(), "--models-dir", models.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }

  close(stdin_pipe[0]);
  close(stdout_pipe[1]);
  impl_->stdin_write = stdin_pipe[1];
  impl_->stdout_read = stdout_pipe[0];
  impl_->proc = child;
#endif

  impl_->started = true;
  impl_->reader_stop.store(false);

  impl_->reader = std::thread([this]() {
    std::string buffer;
    char chunk[4096];
    while (!impl_->reader_stop.load()) {
#ifdef _WIN32
      DWORD read = 0;
      if (!ReadFile(impl_->stdout_read, chunk, sizeof(chunk) - 1, &read, nullptr) || read == 0) {
        break;
      }
      chunk[read] = '\0';
#else
      const ssize_t read = ::read(impl_->stdout_read, chunk, sizeof(chunk) - 1);
      if (read <= 0) break;
      chunk[read] = '\0';
#endif
      buffer += chunk;
      size_t pos = 0;
      while ((pos = buffer.find('\n')) != std::string::npos) {
        const std::string line = buffer.substr(0, pos);
        buffer.erase(0, pos + 1);
        ingest_line(line);
      }
    }
    if (!impl_->reader_stop.load()) {
      notify_process_exited("omega-engine process exited");
    }
  });

#ifdef _WIN32
  {
    std::string startup_error;
    if (!wait_for_engine_process_alive(impl_->proc, startup_error)) {
      shutdown_process_handles();
      impl_->last_error = startup_error;
      return false;
    }
  }
#endif

  return true;
}

json EngineClient::command(const std::string& type, const json& payload, int timeout_ms) {
  const std::string id = random_id();
  json req{{"id", id}, {"type", type}, {"payload", payload}};
  const std::string line = json_dump_safe(req) + "\n";

  {
    std::lock_guard io_lock(impl_->io_mu);
    if (!ensure_started()) {
      throw std::runtime_error(last_error().empty() ? "omega-engine unavailable" : last_error());
    }
#ifdef _WIN32
    if (!write_all(impl_->stdin_write, line)) {
      notify_process_exited("failed to write to omega-engine stdin");
      throw std::runtime_error("failed to write to omega-engine stdin");
    }
#else
    if (!write_all(impl_->stdin_write, line)) {
      notify_process_exited("failed to write to omega-engine stdin");
      throw std::runtime_error("failed to write to omega-engine stdin");
    }
#endif
  }

  {
    std::lock_guard guard(impl_->mu);
    impl_->pending_commands.insert(id);
  }

  std::unique_lock lock(impl_->mu);
  const bool ok = impl_->cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
    return impl_->responses.find(id) != impl_->responses.end();
  });
  if (!ok) {
    impl_->pending_commands.erase(id);
    throw std::runtime_error("omega-engine command timed out: " + type);
  }

  json resp = impl_->responses[id];
  impl_->responses.erase(id);
  lock.unlock();

  if (!resp.value("success", false)) {
    throw std::runtime_error(resp.value("error", "engine error"));
  }
  return resp.contains("data") ? resp["data"] : json::object();
}

json EngineClient::chat_send(const json& payload, const std::string& session_id,
                             ChatTokenCallback on_token, ChatMetricsCallback on_metrics,
                             int timeout_ms) {
  json req{{"id", session_id}, {"type", "chat.send"}, {"payload", payload}};
  const std::string line = json_dump_safe(req) + "\n";

  {
    std::lock_guard io_lock(impl_->io_mu);
    if (!ensure_started()) {
      throw std::runtime_error(last_error().empty() ? "omega-engine unavailable" : last_error());
    }
    {
      std::lock_guard lock(impl_->mu);
      impl_->chat_slots[session_id] =
          Impl::ChatSlot{std::move(on_token), std::move(on_metrics), json::object(), false, false,
                         ""};
    }
#ifdef _WIN32
    if (!write_all(impl_->stdin_write, line)) {
#else
    if (!write_all(impl_->stdin_write, line)) {
#endif
      std::lock_guard lock(impl_->mu);
      impl_->chat_slots.erase(session_id);
      notify_process_exited("failed to write to omega-engine stdin");
      throw std::runtime_error("failed to write to omega-engine stdin");
    }
  }

  std::unique_lock lock(impl_->mu);
  const bool ok = impl_->cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&]() {
    const auto it = impl_->chat_slots.find(session_id);
    return it != impl_->chat_slots.end() && (it->second.finished || it->second.failed);
  });

  if (!ok) {
    impl_->chat_slots.erase(session_id);
    throw std::runtime_error("omega-engine chat timed out");
  }

  const Impl::ChatSlot slot = impl_->chat_slots[session_id];
  impl_->chat_slots.erase(session_id);
  lock.unlock();

  if (slot.failed) throw std::runtime_error(slot.error.empty() ? "chat error" : slot.error);
  return slot.result;
}

json EngineClient::chat_abort(const std::string& session_id) {
  return command("chat.abort", json{{"sessionId", session_id}}, 10000);
}

}  // namespace omega::runtime
