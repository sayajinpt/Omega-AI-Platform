#include "omega/shell/runtime_supervisor.hpp"

#include "omega/shell/app_paths.hpp"

#include <Windows.h>
#include <TlHelp32.h>
#include <winhttp.h>

#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace omega::shell {

namespace fs = std::filesystem;

namespace {

constexpr int kRuntimePort = 9877;
constexpr DWORD kStopWaitMs = 5000;

std::wstring widen(const std::string& s) {
  if (s.empty()) return L"";
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

std::string narrow(const std::wstring& ws) {
  if (ws.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, out.data(), n, nullptr, nullptr);
  if (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

std::wstring env_var_name(const std::wstring& entry) {
  const auto pos = entry.find(L'=');
  if (pos == std::wstring::npos) return entry;
  return entry.substr(0, pos);
}

bool env_name_iequals(const std::wstring& a, const std::wstring& b) {
  return _wcsicmp(a.c_str(), b.c_str()) == 0;
}

std::wstring build_env_block() {
  std::vector<std::wstring> pairs;
  auto add = [&](const std::wstring& k, const std::wstring& v) {
    pairs.push_back(k + L"=" + v);
  };

  wchar_t* env = GetEnvironmentStringsW();
  if (env) {
    for (wchar_t* p = env; *p;) {
      const std::wstring entry(p);
      const std::wstring name = env_var_name(entry);
      // Replace PATH and all OMEGA_* vars with our packaged values below.
      if (name.rfind(L"OMEGA_", 0) == 0 || env_name_iequals(name, L"PATH")) {
        p += entry.size() + 1;
        continue;
      }
      pairs.push_back(entry);
      p += entry.size() + 1;
    }
    FreeEnvironmentStringsW(env);
  }

  add(L"OMEGA_HOME", widen(omega_home()));
  add(L"OMEGA_RUNTIME_PORT", std::to_wstring(kRuntimePort));
  add(L"OMEGA_SHELL_URL", L"http://127.0.0.1:9878");
  add(L"PATH", widen(augmented_path()));

  const std::string resources = resources_dir();
  if (file_exists(resources)) {
    add(L"OMEGA_RESOURCES_DIR", widen(resources));
    const std::string engines = (fs::path(resources) / "engines").string();
    if (file_exists(engines)) add(L"OMEGA_ENGINES_ROOT", widen(engines));
    const std::string py_unified = (fs::path(engines) / "python-unified").string();
    if (file_exists(py_unified)) add(L"OMEGA_PYTHON_UNIFIED_ROOT", widen(py_unified));
    const std::string claw3d = (fs::path(resources) / "claw3d-office").string();
    if (file_exists(claw3d)) add(L"OMEGA_CLAW3D_OFFICE_ROOT", widen(claw3d));
  }

  const std::string engine = engine_binary_path();
  if (file_exists(engine)) add(L"OMEGA_ENGINE_BIN", widen(engine));

  const std::string ollama = ollama_binary_path();
  if (file_exists(ollama)) add(L"OMEGA_OLLAMA_BIN", widen(ollama));

  std::wstring block;
  for (const auto& p : pairs) {
    block += p;
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

bool http_health_ok(int port) {
  HINTERNET session =
      WinHttpOpen(L"omega-desktop/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                  WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return false;

  HINTERNET connect = WinHttpConnect(session, L"127.0.0.1", static_cast<INTERNET_PORT>(port), 0);
  if (!connect) {
    WinHttpCloseHandle(session);
    return false;
  }

  HINTERNET request = WinHttpOpenRequest(connect, L"GET", L"/healthz", nullptr, WINHTTP_NO_REFERER,
                                         WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
  if (!request) {
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return false;
  }

  const BOOL sent = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA,
                                       0, 0, 0);
  if (!sent || !WinHttpReceiveResponse(request, nullptr)) {
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return false;
  }

  DWORD status = 0;
  DWORD size = sizeof(status);
  WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                      WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX);

  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connect);
  WinHttpCloseHandle(session);
  return status == 200;
}

void terminate_process_by_id(DWORD pid) {
  const HANDLE h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return;
  TerminateProcess(h, 0);
  WaitForSingleObject(h, 2000);
  CloseHandle(h);
}

void terminate_processes_by_exe(const wchar_t* exe_name) {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return;
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof(pe);
  if (Process32FirstW(snap, &pe)) {
    do {
      if (_wcsicmp(pe.szExeFile, exe_name) == 0) {
        terminate_process_by_id(pe.th32ProcessID);
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
}

void cleanup_stale_omega_processes() {
  // Fresh launch should never inherit old stuck runtime/infer processes.
  terminate_processes_by_exe(L"omega-runtime.exe");
  terminate_processes_by_exe(L"omega-engine.exe");
}

}  // namespace

RuntimeSupervisor::RuntimeSupervisor() = default;

RuntimeSupervisor::~RuntimeSupervisor() { stop(); }

void RuntimeSupervisor::start() {
  if (ready_) return;
  cleanup_stale_omega_processes();

  const std::string bin = runtime_binary_path();
  if (!file_exists(bin)) {
    last_error_ = "omega-runtime missing: " + bin;
    throw std::runtime_error(last_error_);
  }

  std::wstring env_block = build_env_block();
  std::wstring cmd = L"\"" + widen(bin) + L"\" --port " + std::to_wstring(kRuntimePort);
  const std::wstring cwd = widen(fs::path(bin).parent_path().string());

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};

  std::vector<wchar_t> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back(L'\0');

  const DWORD flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
  if (!CreateProcessW(nullptr, cmd_buf.data(), nullptr, nullptr, FALSE, flags, env_block.data(),
                      cwd.empty() ? nullptr : cwd.c_str(), &si, &pi)) {
    last_error_ = "CreateProcess failed: " + std::to_string(GetLastError());
    throw std::runtime_error(last_error_);
  }

  CloseHandle(pi.hThread);
  process_handle_ = pi.hProcess;
  process_id_ = pi.dwProcessId;

  // Ensure child processes die when shell exits or runtime is killed.
  if (job_handle_) {
    CloseHandle(static_cast<HANDLE>(job_handle_));
    job_handle_ = nullptr;
  }
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli)) &&
        AssignProcessToJobObject(job, process_handle_)) {
      job_handle_ = job;
    } else {
      CloseHandle(job);
    }
  }

  if (!wait_for_health(kRuntimePort)) {
    last_error_ = "omega-runtime did not respond on /healthz";
    stop();
    throw std::runtime_error(last_error_);
  }

  ready_ = true;
  last_error_.clear();
}

void RuntimeSupervisor::stop() {
  if (process_handle_) {
    TerminateProcess(static_cast<HANDLE>(process_handle_), 0);
    WaitForSingleObject(static_cast<HANDLE>(process_handle_), kStopWaitMs);
    CloseHandle(static_cast<HANDLE>(process_handle_));
    process_handle_ = nullptr;
  }
  if (job_handle_) {
    CloseHandle(static_cast<HANDLE>(job_handle_));
    job_handle_ = nullptr;
  }
  process_id_ = 0;
  ready_ = false;
}

bool RuntimeSupervisor::wait_for_health(int port, int attempts) {
  for (int i = 0; i < attempts; ++i) {
    if (http_health_ok(port)) return true;
    Sleep(250);
  }
  return false;
}

}  // namespace omega::shell
