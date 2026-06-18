#include "omega/runtime/services/terminal_store.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/process_util.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string random_suffix() {
  static std::mt19937 rng{std::random_device{}()};
  static std::uniform_int_distribution<int> dist(0, 15);
  std::string out;
  for (int i = 0; i < 8; ++i) out += "0123456789abcdef"[dist(rng)];
  return out;
}

std::string snippets_dir(ProfileContext& profile) {
  const fs::path dir = fs::path(profile.profile_home()) / "workspace" / "snippets";
  fs::create_directories(dir);
  return dir.string();
}

bool path_under_workspace(ProfileContext& profile, const fs::path& abs) {
  std::error_code ec;
  const fs::path workspace = fs::weakly_canonical(fs::path(profile.profile_home()) / "workspace", ec);
  const fs::path target = fs::weakly_canonical(abs, ec);
  if (ec) return false;
  const std::string ws = workspace.generic_string();
  const std::string tgt = target.generic_string();
  return tgt == ws || tgt.starts_with(ws + "/") || tgt.starts_with(ws + "\\");
}

std::string lang_ext(const std::string& lang) {
  const std::string l = lang;
  if (l == "html" || l == "htm") return "html";
  if (l == "css") return "css";
  if (l == "javascript" || l == "js" || l == "jsx") return "js";
  if (l == "typescript" || l == "ts" || l == "tsx") return "ts";
  if (l == "python" || l == "py") return "py";
  if (l == "json") return "json";
  if (l == "shell" || l == "bash" || l == "sh" || l == "powershell" || l == "ps1") return "sh";
  return "txt";
}

fs::path resolve_python_script(ProfileContext& profile, const json& opts, const std::string& lang) {
  const std::string path_opt = opts.value("path", "");
  const std::string name_opt = opts.value("suggestedName", opts.value("filename", ""));

  if (!path_opt.empty()) {
    const fs::path abs = fs::absolute(path_opt);
    if (!path_under_workspace(profile, abs)) {
      throw std::runtime_error("script path must be under workspace");
    }
    return abs;
  }

  const fs::path base = fs::path(snippets_dir(profile));
  if (!name_opt.empty()) {
    return base / fs::path(name_opt).filename();
  }

  return base / ("run-" + random_suffix() + "." + lang_ext(lang));
}

void write_script(const fs::path& script, const std::string& code) {
  fs::create_directories(script.parent_path());
  std::ofstream out(script, std::ios::binary);
  if (!out) throw std::runtime_error("failed to write snippet: " + script.string());
  out << code;
}

bool python_uses_stdin(const std::string& code) {
  return code.find("input(") != std::string::npos;
}

const char* k_python_stdin_msg =
    "This script uses input(), which needs an interactive terminal. Ωmega runs Python "
    "non-interactively — use fixed values in the script, or run it in an external terminal.";

}  // namespace

TerminalStore::TerminalStore(EventBus& events) : events_(events) {}

json TerminalStore::push_line(const std::string& kind, const std::string& text) {
  const int64_t at = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
  json line{{"id", "t" + std::to_string(++seq_)},
            {"at", at},
            {"kind", kind},
            {"text", text}};
  {
    std::lock_guard lock(mu_);
    lines_.push_back(line);
    while (lines_.size() > k_max) lines_.pop_front();
  }
  events_.publish("omega:terminal:line", line);
  return line;
}

json TerminalStore::history() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (const auto& line : lines_) out.push_back(line);
  return out;
}

void TerminalStore::clear() {
  {
    std::lock_guard lock(mu_);
    lines_.clear();
  }
  push_line("info", "Terminal cleared.");
}

json TerminalStore::append_line(const std::string& kind, const std::string& text) {
  return push_line(kind, text);
}

json TerminalStore::save_snippet(ProfileContext& profile, const std::string& content,
                                 const std::string& suggested_name) {
  const fs::path dest = fs::path(snippets_dir(profile)) / fs::path(suggested_name).filename();
  write_script(dest, content);
  push_line("ok", "Saved " + dest.string());
  return dest.string();
}

json TerminalStore::run_snippet(ConfigStore& config, ProfileContext& profile,
                                  const json& opts) {
  const std::string lang = opts.value("lang", "");
  const std::string code = opts.value("code", "");
  if (code.empty()) return json{{"ok", false}, {"error", "Empty snippet"}};

  const std::string lower = lang;
  const bool looks_html =
      lower == "html" || lower == "htm" ||
      (lower == "text" &&
       (code.find("<!DOCTYPE") != std::string::npos || code.find("<html") != std::string::npos));
  if (looks_html) {
    const fs::path file = fs::path(snippets_dir(profile)) / ("preview-" + random_suffix() + ".html");
    write_script(file, code);
    push_line("cmd", "Open HTML preview: " + file.string());
    push_line("info", "HTML saved — open in browser (native runtime has no embedded browser preview).");
    return json{{"ok", true}, {"script", file.string()}};
  }

  const json cfg = config.load();
  const bool allow_shell = cfg.value("allowShell", false);

  if (lower == "python" || lower == "py") {
    if (python_uses_stdin(code)) {
      push_line("error", k_python_stdin_msg);
      return json{{"ok", false}, {"error", k_python_stdin_msg}};
    }
    const fs::path script = resolve_python_script(profile, opts, lower);
    write_script(script, code);

    const std::string py = resolve_unified_python();
    if (!fs::exists(py)) {
      push_line("error", "Python venv missing — run POST /v1/python/setup first");
      return json{{"ok", false}, {"error", "Python venv missing"}};
    }

    const std::string cmdline = shell_quote(py) + " -u " + shell_quote(script.string());
    push_line("cmd", py + " -u " + script.string());

    const CommandResult run = run_process_capture(cmdline, script.parent_path().string());
    if (!run.started) {
      const std::string err =
          "Failed to start Python (error " + std::to_string(run.spawn_error) + ")";
      push_line("error", err);
      return json{{"ok", false}, {"error", err}, {"script", script.string()}};
    }

    if (!run.output.empty()) {
      push_line("stdout", run.output);
    } else {
      push_line("info", "(no output)");
    }

    if (run.exit_code != 0) {
      push_line("error", "Python exited with code " + std::to_string(run.exit_code));
      return json{{"ok", false},
                  {"error", "Exit code " + std::to_string(run.exit_code)},
                  {"output", run.output},
                  {"script", script.string()}};
    }

    push_line("ok", "Python finished (exit 0).");
    return json{{"ok", true}, {"output", run.output}, {"script", script.string()}};
  }

  if (lower == "shell" || lower == "bash" || lower == "sh" || lower == "powershell" ||
      lower == "ps1") {
    const bool user_terminal = opts.value("source", "") == "terminal";
    if (!allow_shell && !user_terminal) {
      return json{{"ok", false},
                  {"error",
                   "Shell runs are disabled. Enable allowShell in config or save and run manually."}};
    }
    push_line("cmd", code.substr(0, std::min<size_t>(120, code.size())));
#ifdef _WIN32
    const std::string cmdline = "cmd /c " + shell_quote(code + " 2>&1");
#else
    const std::string cmdline = code + " 2>&1";
#endif
    std::string cwd;
    if (opts.contains("cwd") && opts["cwd"].is_string()) {
      cwd = opts["cwd"].get<std::string>();
    } else if (user_terminal) {
      cwd = (fs::path(profile.profile_home()) / "workspace").string();
    }
    const CommandResult run = run_process_capture(cmdline, cwd);
    if (!run.started) {
      push_line("error", "Failed to start shell command");
      return json{{"ok", false}, {"error", "Failed to start shell command"}};
    }
    if (!run.output.empty()) {
      push_line(run.output.find("error") == std::string::npos ? "stdout" : "stderr", run.output);
    } else {
      push_line("info", "(no output)");
    }
    if (run.exit_code != 0) {
      return json{{"ok", false},
                  {"error", "Exit code " + std::to_string(run.exit_code)},
                  {"output", run.output}};
    }
    push_line("ok", "Shell finished.");
    return json{{"ok", true}, {"output", run.output}};
  }

  if (lower == "javascript" || lower == "js") {
    return json{{"ok", false},
                {"error",
                 "JavaScript snippets are not supported — use Python snippets or the run_python tool."}};
  }

  return json{{"ok", false},
              {"error", "No runner for \"" + (lang.empty() ? "plain" : lang) +
                            "\". Use Copy/Download or agent tools."}};
}

}  // namespace omega::runtime
