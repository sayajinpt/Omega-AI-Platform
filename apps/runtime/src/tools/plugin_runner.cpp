#include "omega/runtime/tools/plugin_runner.hpp"

#include "omega/runtime/paths.hpp"

#include <cstdio>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

#ifdef _WIN32
std::string shell_quote(const std::string& s) {
  if (s.find_first_of(" \t\"") == std::string::npos) return s;
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += '"';
  return out;
}
#else
std::string shell_quote(const std::string& s) {
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
}
#endif

std::string read_command_output(const std::string& cmd) {
  std::string out;
#ifdef _WIN32
  FILE* pipe = _popen(cmd.c_str(), "r");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return out;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) out += buf;
#ifdef _WIN32
  _pclose(pipe);
#else
  pclose(pipe);
#endif
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) {
    out.pop_back();
  }
  return out;
}

}  // namespace

std::string resolve_plugin_invoke_script() { return resolve_python_runtime_script("plugin_invoke.py"); }

json invoke_plugin_tool(const std::string& plugin_dir, const std::string& tool_name,
                        const json& args) {
  const std::string py = resolve_unified_python();
  const std::string script = resolve_plugin_invoke_script();
  if (!fs::exists(py)) {
    throw std::runtime_error("Unified Python venv missing — run POST /v1/python/setup first");
  }
  if (!fs::exists(script)) {
    throw std::runtime_error("plugin_invoke.py not found — reinstall Omega runtime");
  }
  if (!fs::exists(fs::path(plugin_dir) / "index.py") &&
      !fs::exists(fs::path(plugin_dir) / "index.js")) {
    throw std::runtime_error("plugin entry index.py missing");
  }

  const std::string args_json = args.is_object() ? args.dump() : "{}";
  const std::string cmd = shell_quote(py) + " " + shell_quote(script) + " " +
                          shell_quote(plugin_dir) + " " + shell_quote(tool_name) + " " +
                          shell_quote(args_json);

  const std::string output = read_command_output(cmd + " 2>&1");
  if (output.empty()) {
    return json{{"ok", false}, {"output", "plugin produced no output"}};
  }

  try {
    const json parsed = json::parse(output);
    if (parsed.is_object() && parsed.contains("ok")) return parsed;
  } catch (...) {
  }
  return json{{"ok", false}, {"output", output.substr(0, 8000)}};
}

}  // namespace omega::runtime
