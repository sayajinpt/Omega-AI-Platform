#include "omega/runtime/process_util.hpp"

#include <cstdio>
#include <regex>
#include <vector>

#ifndef _WIN32
#include <sys/wait.h>
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace omega::runtime {

std::string shell_quote(const std::string& s) {
#ifdef _WIN32
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

std::string normalize_windows_shell_command(std::string command) {
#ifdef _WIN32
  static const std::regex ping_c_spaced(R"((\bping(?:\.exe)?)\s+-c\s*(\d+))",
                                        std::regex_constants::icase);
  command = std::regex_replace(command, ping_c_spaced, "$1 -n $2");
  static const std::regex ping_c_tight(R"((\bping(?:\.exe)?)\s+-c(\d+))", std::regex_constants::icase);
  command = std::regex_replace(command, ping_c_tight, "$1 -n $2");
  static const std::regex ping_c_suffix(R"((\bping(?:\.exe)?\s+\S+)\s+-c\s*(\d+))",
                                        std::regex_constants::icase);
  command = std::regex_replace(command, ping_c_suffix, "$1 -n $2");
#endif
  return command;
}

CommandResult run_shell_capture(const std::string& command, const std::string& cwd) {
#ifdef _WIN32
  const std::string normalized = normalize_windows_shell_command(command);
  std::string with_stderr = normalized;
  if (with_stderr.find("2>&1") == std::string::npos) with_stderr += " 2>&1";
  const std::string cmdline = "cmd /c " + shell_quote(with_stderr);
  return run_process_capture(cmdline, cwd);
#else
  const std::string cmdline = "/bin/sh -c " + shell_quote(command);
  return run_process_capture(cmdline, cwd);
#endif
}

CommandResult run_process_capture(const std::string& cmdline, const std::string& cwd) {
  CommandResult result;

#ifdef _WIN32
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(SECURITY_ATTRIBUTES);
  sa.bInheritHandle = TRUE;

  HANDLE out_read = nullptr;
  HANDLE out_write = nullptr;
  if (!CreatePipe(&out_read, &out_write, &sa, 0)) {
    result.spawn_error = static_cast<int>(GetLastError());
    return result;
  }

  if (!SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0)) {
    CloseHandle(out_read);
    CloseHandle(out_write);
    result.spawn_error = static_cast<int>(GetLastError());
    return result;
  }

  STARTUPINFOA si{};
  si.cb = sizeof(STARTUPINFOA);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdOutput = out_write;
  si.hStdError = out_write;
  si.hStdInput = INVALID_HANDLE_VALUE;

  PROCESS_INFORMATION pi{};
  std::vector<char> cmd_buf(cmdline.begin(), cmdline.end());
  cmd_buf.push_back('\0');

  const char* cwd_ptr = cwd.empty() ? nullptr : cwd.c_str();
  const BOOL ok = CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                 nullptr, cwd_ptr, &si, &pi);
  CloseHandle(out_write);

  if (!ok) {
    CloseHandle(out_read);
    result.spawn_error = static_cast<int>(GetLastError());
    return result;
  }

  result.started = true;
  CloseHandle(pi.hThread);

  char buf[4096];
  for (;;) {
    DWORD n = 0;
    while (ReadFile(out_read, buf, sizeof(buf) - 1, &n, nullptr) && n > 0) {
      buf[n] = '\0';
      result.output += buf;
    }
    const DWORD wait = WaitForSingleObject(pi.hProcess, 50);
    if (wait != WAIT_TIMEOUT) break;
  }

  DWORD n = 0;
  while (ReadFile(out_read, buf, sizeof(buf) - 1, &n, nullptr) && n > 0) {
    buf[n] = '\0';
    result.output += buf;
  }

  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  result.exit_code = static_cast<int>(code);
  CloseHandle(pi.hProcess);
  CloseHandle(out_read);
#else
  const std::string cmd = cmdline + " 2>&1";
  FILE* pipe = popen(cmd.c_str(), "r");
  if (!pipe) return result;
  result.started = true;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) result.output += buf;
  const int status = pclose(pipe);
  result.exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#endif

  return result;
}

}  // namespace omega::runtime
