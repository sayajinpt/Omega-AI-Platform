#pragma once

#include <string>
#include <vector>

namespace omega::runtime {

struct CommandResult {
  std::string output;
  int exit_code = -1;
  bool started = false;
  int spawn_error = 0;
};

std::string shell_quote(const std::string& s);

/** Rewrite common Linux-only flags for cmd.exe (e.g. ping -c → ping -n on Windows). */
std::string normalize_windows_shell_command(std::string command);

/** Run a shell command string; on Windows uses cmd /c with reliable CreateProcess capture. */
CommandResult run_shell_capture(const std::string& command, const std::string& cwd = {});

/** Run a full command line (executable + args already quoted). Captures stdout+stderr. */
CommandResult run_process_capture(const std::string& cmdline, const std::string& cwd = {});

}  // namespace omega::runtime
