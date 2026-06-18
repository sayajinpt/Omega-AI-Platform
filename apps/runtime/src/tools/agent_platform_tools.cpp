#include "omega/runtime/tools/agent_platform_tools.hpp"

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/finetune/finetune_capabilities.hpp"
#include "omega/runtime/finetune/finetune_dataset_service.hpp"
#include "omega/runtime/finetune/finetune_runner.hpp"
#include "omega/runtime/inference/media_engine_router.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/models/model_meta_service.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/process_util.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/services/chat_tts_orchestrator.hpp"
#include "omega/runtime/services/workforce_orchestrator.hpp"
#include "omega/runtime/storage/finetune_store.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/plugin_store.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/session_cleanup.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/storage/skills_store.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <httplib.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string arg_str(const std::map<std::string, std::string>& args, const std::string& key,
                    const std::string& fallback = "") {
  const auto it = args.find(key);
  return it == args.end() ? fallback : it->second;
}

bool arg_bool(const std::map<std::string, std::string>& args, const std::string& key,
              bool fallback = false) {
  const std::string v = arg_str(args, key);
  if (v.empty()) return fallback;
  const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(v[0])));
  return v == "1" || v == "true" || v == "yes" || c == 't' || c == 'y';
}

int arg_int(const std::map<std::string, std::string>& args, const std::string& key, int fallback) {
  const std::string v = arg_str(args, key);
  if (v.empty()) return fallback;
  try {
    return std::stoi(v);
  } catch (...) {
    return fallback;
  }
}

json tool_ok(const std::string& output, const json& parts = json::array()) {
  json out{{"ok", true}, {"output", output}};
  if (parts.is_array() && !parts.empty()) out["parts"] = parts;
  return out;
}

json tool_err(const std::string& msg) { return json{{"ok", false}, {"output", msg}}; }

json code_block_part(const std::string& lang, const std::string& code) {
  return json{{"type", "text"}, {"text", "```" + lang + "\n" + code + "\n```"}};
}

json terminal_output_part(const std::string& label, const std::string& output) {
  const std::string body = output.empty() ? "(no output)" : output;
  return json{{"type", "text"},
              {"text", "**" + label + "**\n\n```text\n" + body + "\n```"}};
}

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

uintmax_t dir_size(const fs::path& root) {
  uintmax_t total = 0;
  std::error_code ec;
  if (!fs::exists(root, ec)) return 0;
  for (fs::recursive_directory_iterator it(root, ec), end; it != end; it.increment(ec)) {
    if (ec || !it->is_regular_file(ec)) continue;
    total += it->file_size(ec);
  }
  return total;
}

std::string format_bytes(uintmax_t bytes) {
  const double b = static_cast<double>(bytes);
  if (b >= 1024.0 * 1024.0 * 1024.0) return std::to_string(b / (1024.0 * 1024.0 * 1024.0)) + " GB";
  if (b >= 1024.0 * 1024.0) return std::to_string(b / (1024.0 * 1024.0)) + " MB";
  if (b >= 1024.0) return std::to_string(b / 1024.0) + " KB";
  return std::to_string(bytes) + " B";
}

json omega_capabilities_map() {
  return json{
      {"chat", json{{"tools", json::array({"chat_manage", "chat_read_cache", "chat_choice_card"})}}},
      {"files",
       json{{"tools", json::array({"read_file", "write_file", "list_dir", "grep_files", "glob_files"})}}},
      {"coding",
       json{{"tools", json::array({"run_python", "run_shell", "run_process"})}}},
      {"inference",
       json{{"tools", json::array({"inference_status", "list_models", "load_model", "unload_model"})}}},
      {"media",
       json{{"tools", json::array({"play_youtube", "play_local_media", "search_local_media", "media_stop", "audio_generate"})}}},
      {"browser", json{{"tools", json::array({"browser_navigate", "browser_snapshot", "web_fetch"})}}},
      {"content_studio",
       json{{"tools", json::array({"content_create_run", "content_run_status", "content_list_projects"})}}},
      {"plugins",
       json{{"tools", json::array({"plugin_catalog", "install_plugin", "write_plugin", "reload_plugins"})}}},
      {"workforce", json{{"tools", json::array({"delegate_to_agent", "run_moa", "plan_tasks"})}}},
      {"memory", json{{"tools", json::array({"search_memory", "add_memory", "search_docs"})}}},
      {"finetune",
       json{{"tools", json::array({"finetune_analyze", "finetune_start", "finetune_status"})}}}};
}

std::string capture_command(const std::string& cmd) {
#ifdef _WIN32
  const std::string cmdline = "cmd /c " + shell_quote(cmd);
  return run_process_capture(cmdline).output;
#else
  return run_process_capture(cmd).output;
#endif
}

bool python_uses_stdin(const std::string& code) {
  return code.find("input(") != std::string::npos;
}

const char* k_python_stdin_msg =
    "This script uses input(), which needs an interactive terminal. Ωmega runs Python "
    "non-interactively — use fixed values in the script, or run it in an external terminal.";

#ifdef _WIN32
std::string clipboard_read_text() {
  if (!OpenClipboard(nullptr)) return "";
  HANDLE data = GetClipboardData(CF_UNICODETEXT);
  if (!data) {
    CloseClipboard();
    return "";
  }
  const auto* text = static_cast<const wchar_t*>(GlobalLock(data));
  if (!text) {
    CloseClipboard();
    return "";
  }
  const int needed = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
  std::string out;
  if (needed > 1) {
    out.resize(static_cast<size_t>(needed - 1));
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), needed, nullptr, nullptr);
  }
  GlobalUnlock(data);
  CloseClipboard();
  return out;
}

bool clipboard_write_text(const std::string& text) {
  if (!OpenClipboard(nullptr)) return false;
  EmptyClipboard();
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
  if (wlen <= 0) {
    CloseClipboard();
    return false;
  }
  HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, static_cast<SIZE_T>(wlen) * sizeof(wchar_t));
  if (!mem) {
    CloseClipboard();
    return false;
  }
  auto* buf = static_cast<wchar_t*>(GlobalLock(mem));
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, buf, wlen);
  GlobalUnlock(mem);
  SetClipboardData(CF_UNICODETEXT, mem);
  CloseClipboard();
  return true;
}
#else
std::string clipboard_read_text() {
#if defined(__APPLE__)
  std::string out = capture_command("pbpaste 2>/dev/null");
#elif defined(__linux__)
  std::string out = capture_command("wl-paste -n 2>/dev/null");
  if (out.empty()) out = capture_command("xclip -selection clipboard -o 2>/dev/null");
#else
  std::string out;
#endif
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
  return out;
}

bool clipboard_write_text(const std::string& text) {
  auto write_via = [&](const char* cmd) -> bool {
    FILE* pipe = popen(cmd, "w");
    if (!pipe) return false;
    if (!text.empty()) {
      const size_t n = fwrite(text.data(), 1, text.size(), pipe);
      if (n != text.size()) {
        pclose(pipe);
        return false;
      }
    }
    return pclose(pipe) == 0;
  };
#if defined(__APPLE__)
  return write_via("pbcopy");
#elif defined(__linux__)
  if (write_via("wl-copy 2>/dev/null")) return true;
  return write_via("xclip -selection clipboard 2>/dev/null");
#else
  (void)write_via;
  return false;
#endif
}
#endif

std::string resolve_stealth_fetch_script() { return resolve_python_runtime_script("stealth_fetch.py"); }

json run_stealth_fetch(const std::map<std::string, std::string>& args) {
  const std::string url = arg_str(args, "url");
  if (url.empty()) return tool_err("url required");
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    return tool_err("Unified Python venv missing — run POST /v1/python/setup first");
  }
  const std::string script = resolve_stealth_fetch_script();
  if (!fs::exists(script)) {
    return tool_err("stealth_fetch.py missing — reinstall Omega runtime");
  }
  json payload{{"url", url}};
  const std::string selector = arg_str(args, "selector");
  if (!selector.empty()) payload["selector"] = selector;
  const int wait_ms = arg_int(args, "waitMs", arg_int(args, "wait_ms", 1500));
  if (wait_ms > 0) payload["waitMs"] = wait_ms;
  const int timeout_ms = arg_int(args, "timeoutMs", arg_int(args, "timeout_ms", 45000));
  if (timeout_ms > 0) payload["timeoutMs"] = timeout_ms;
  const std::string cmd = shell_quote(py) + " " + shell_quote(script) + " " +
                          shell_quote(payload.dump());
  const std::string raw = capture_command(cmd);
  try {
    const json parsed = json::parse(raw);
    return json{{"ok", parsed.value("ok", false)}, {"output", parsed.value("output", raw)}};
  } catch (...) {
    return tool_err(raw.empty() ? "browser_stealth_fetch produced no output" : raw);
  }
}

json run_shell_command(const std::map<std::string, std::string>& args) {
  const std::string command = arg_str(args, "command", arg_str(args, "cmd"));
  if (command.empty()) return tool_err("command required");
  std::string cwd = arg_str(args, "cwd", ".");
  if (cwd.empty()) cwd = ".";
  std::error_code ec;
  if (!fs::exists(cwd, ec)) return tool_err("cwd does not exist: " + cwd);
  const CommandResult cap = run_shell_capture(command, fs::absolute(cwd).string());
  if (!cap.started) {
    std::string err = "failed to start shell command";
    if (cap.spawn_error != 0) err += " (error " + std::to_string(cap.spawn_error) + ")";
    return tool_err(err);
  }
  std::string raw = cap.output;
  if (raw.find("Option -c requires administrative privileges") != std::string::npos) {
    raw +=
        "\n\n(Note: ping -c is Linux-only. On Windows use ping -n <count>, e.g. ping -n 4 google.com.)";
  }
  return tool_ok(raw.empty() ? "(no output)" : raw,
                 json::array({terminal_output_part("Terminal (run_shell)", raw)}));
}

json run_process_command(const std::map<std::string, std::string>& args) {
  const std::string exe = arg_str(args, "executable", arg_str(args, "program"));
  if (exe.empty()) return tool_err("executable required");
  std::string cmd = shell_quote(exe);
  const std::string args_json = arg_str(args, "argsJson", arg_str(args, "args_json"));
  if (!args_json.empty()) {
    try {
      const json arr = json::parse(args_json);
      if (arr.is_array()) {
        for (const auto& a : arr) cmd += " " + shell_quote(a.get<std::string>());
      }
    } catch (...) {
      return tool_err("argsJson must be a JSON string array");
    }
  } else {
    const std::string extra = arg_str(args, "args");
    if (!extra.empty()) cmd += " " + extra;
  }
  std::string cwd = arg_str(args, "cwd");
  if (!cwd.empty()) {
#ifdef _WIN32
    cmd = "cd /d " + shell_quote(fs::absolute(cwd).string()) + " && " + cmd + " 2>&1";
#else
    cmd = "cd " + shell_quote(fs::absolute(cwd).string()) + " && " + cmd + " 2>&1";
#endif
  } else {
    cmd += " 2>&1";
  }
  const std::string raw = capture_command(cmd);
  return tool_ok(raw.empty() ? "(no output)" : raw,
                 json::array({terminal_output_part("Terminal (run_process)", raw)}));
}

json run_python_code(const std::string& code) {
  if (python_uses_stdin(code)) {
    return tool_err(k_python_stdin_msg);
  }
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    return tool_err("Unified Python venv missing — run POST /v1/python/setup first");
  }
  const fs::path tmp = fs::temp_directory_path() / ("omega-py-" + random_uuid() + ".py");
  {
    std::ofstream out(tmp);
    out << code;
  }
  const std::string cmd = shell_quote(py) + " " + shell_quote(tmp.string());
  const std::string raw = capture_command(cmd);
  fs::remove(tmp);
  json parts = json::array({code_block_part("python", code),
                            terminal_output_part("Terminal (run_python)", raw)});
  return tool_ok(raw.empty() ? "(no output)" : raw, parts);
}

json run_python_from_path(ProjectStore* projects, const std::string& session_id,
                         const std::string& rel_path) {
  if (!projects) return tool_err("project store unavailable");
  if (session_id.empty()) return tool_err("sessionId required when using path");
  const fs::path root = fs::path(projects->open_folder(session_id));
  const fs::path abs = fs::absolute(root / rel_path);
  std::error_code ec;
  const fs::path rel = fs::relative(abs, root, ec);
  if (ec || rel.generic_string().starts_with("..")) {
    return tool_err("path escapes project folder");
  }
  if (!fs::exists(abs) || !fs::is_regular_file(abs)) {
    return tool_err("file not found: " + rel_path);
  }
  std::ifstream in(abs, std::ios::binary);
  const std::string code((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  json result = run_python_code(code);
  if (result.value("ok", false)) {
    result["output"] = "ran " + rel_path + "\n" + result.value("output", "");
  }
  return result;
}

json http_request_tool(const std::map<std::string, std::string>& args) {
  const std::string url = arg_str(args, "url");
  if (url.empty()) return tool_err("url required");
  std::string method = arg_str(args, "method", "GET");
  for (char& c : method) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

  const bool https = url.rfind("https://", 0) == 0;
  const bool http = url.rfind("http://", 0) == 0;
  if (!https && !http) return tool_err("url must start with http:// or https://");
  const size_t scheme_len = https ? 8 : 7;
  const size_t path_start = url.find('/', scheme_len);
  const std::string origin =
      path_start == std::string::npos ? url : url.substr(0, path_start);
  const std::string path = path_start == std::string::npos ? "/" : url.substr(path_start);

  httplib::Client cli(origin.c_str());
  cli.set_follow_location(true);
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(30, 0);

  httplib::Headers headers;
  const std::string headers_raw = arg_str(args, "headers");
  if (!headers_raw.empty() && headers_raw.front() == '{') {
    try {
      const json h = json::parse(headers_raw);
      if (h.is_object()) {
        for (auto it = h.begin(); it != h.end(); ++it) {
          if (it.value().is_string()) headers.emplace(it.key(), it.value().get<std::string>());
        }
      }
    } catch (...) {
    }
  }

  const std::string body = arg_str(args, "body");
  httplib::Result res;
  if (method == "POST") res = cli.Post(path.c_str(), headers, body, "application/json");
  else if (method == "PUT") res = cli.Put(path.c_str(), headers, body, "application/json");
  else if (method == "DELETE") res = cli.Delete(path.c_str(), headers);
  else if (method == "PATCH") res = cli.Patch(path.c_str(), headers, body, "application/json");
  else res = cli.Get(path.c_str(), headers);

  if (!res) return tool_err("request failed");
  std::string out = "HTTP " + std::to_string(res->status) + "\n" + res->body;
  if (static_cast<int>(out.size()) > 12000) out = out.substr(0, 12000) + "\n…(truncated)";
  return res->status >= 400 ? tool_err(out) : tool_ok(out);
}

void append_capability_gap(const std::string& goal, const std::string& gap,
                           const std::string& suggestion) {
  const fs::path path = fs::path(omega_home()) / "capability-gaps.jsonl";
  fs::create_directories(path.parent_path());
  std::ofstream out(path, std::ios::app);
  out << json{{"goal", goal}, {"gap", gap}, {"suggestion", suggestion},
                {"ts", std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count()}}
             .dump()
      << '\n';
}

std::vector<std::string> split_semicolon_paths(const std::string& raw) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : raw) {
    if (c == ';') {
      if (!cur.empty()) out.push_back(cur);
      cur.clear();
    } else {
      cur.push_back(c);
    }
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

bool decode_base64(const std::string& in, std::string& out) {
  static const char* k =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<int> T(256, -1);
  for (int i = 0; i < 64; ++i) T[static_cast<unsigned char>(k[i])] = i;
  out.clear();
  int val = 0, valb = -8;
  for (unsigned char c : in) {
    if (T[c] == -1) {
      if (c == '=') break;
      continue;
    }
    val = (val << 6) + T[c];
    valb += 6;
    if (valb >= 0) {
      out.push_back(static_cast<char>((val >> valb) & 0xFF));
      valb -= 8;
    }
  }
  return !out.empty();
}

}  // namespace

void AgentPlatformTools::attach(ConfigStore* config, EngineClient* engine, EventBus* events,
                                SessionStore* sessions, PluginStore* plugins, SkillsStore* skills,
                                MemoryStore* memory, FinetuneStore* finetune_store,
                                FinetuneRunner* finetune_runner,
                                FinetuneDatasetService* finetune_datasets,
                                WorkforceOrchestrator* workforce, ModelMetaService* model_meta,
                                ProjectStore* projects, MediaPlayerService* media,
                                ContentJobDeliveryService* delivery,
                                ContentStudioOrchestrator* content_orchestrator,
                                ContentStudioSupervisor* content_studio, UsageStore* usage) {
  config_ = config;
  engine_ = engine;
  events_ = events;
  sessions_ = sessions;
  plugins_ = plugins;
  skills_ = skills;
  memory_ = memory;
  finetune_store_ = finetune_store;
  finetune_runner_ = finetune_runner;
  finetune_datasets_ = finetune_datasets;
  workforce_ = workforce;
  model_meta_ = model_meta;
  projects_ = projects;
  media_ = media;
  delivery_ = delivery;
  content_orchestrator_ = content_orchestrator;
  content_studio_ = content_studio;
  usage_ = usage;
  tts_orchestrator_.attach(config, engine, projects, media);
}

bool AgentPlatformTools::handles(const std::string& name) const {
  static const char* k[] = {
      "run_python",           "http_request",
      "clipboard_read",       "clipboard_write",      "omega_disk_usage",
      "chat_read_cache",      "chat_manage",          "chat_list",
      "plugin_catalog",       "install_plugin",       "search_plugin_catalog",
      "write_plugin",         "reload_plugins",       "extend_capability",
      "create_skill",         "record_capability_gap", "finetune_analyze",
      "finetune_prepare_dataset", "finetune_start",  "finetune_status",
      "finetune_stop",        "delegate_to_agent",    "run_moa",
      "plan_tasks",           "download_youtube_audio", "browser_stealth_fetch",
      "run_shell",            "run_process",
      "image_generate",       "audio_generate",       "estimate_model_memory",  "omega_capabilities"};
  for (const char* n : k) {
    if (name == n) return true;
  }
  return false;
}

json AgentPlatformTools::run(const std::string& name,
                             const std::map<std::string, std::string>& args) {
  if (name == "omega_capabilities") {
    return tool_ok(omega_capabilities_map().dump(2));
  }

  if (name == "run_python") {
    const std::string code = arg_str(args, "code");
    const std::string path = arg_str(args, "path");
    if (!code.empty()) return run_python_code(code);
    if (!path.empty()) {
      const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
      return run_python_from_path(projects_, session_id, path);
    }
    return tool_err("code or path required");
  }

  if (name == "http_request") return http_request_tool(args);

  if (name == "clipboard_read") {
    const std::string text = clipboard_read_text();
    return text.empty() ? tool_ok("(clipboard empty)") : tool_ok(text);
  }

  if (name == "clipboard_write") {
    const std::string text = arg_str(args, "text");
    if (text.empty()) return tool_err("text required");
    return clipboard_write_text(text) ? tool_ok("clipboard updated")
                                      : tool_err("failed to write clipboard");
  }

  if (name == "omega_disk_usage") {
    const fs::path home = omega_home();
    json report{{"contentStudio", format_bytes(dir_size(home / "content-studio"))},
                {"plugins", format_bytes(dir_size(home / "plugins"))},
                {"models", format_bytes(dir_size(models_dir()))},
                {"finetune", format_bytes(dir_size(home / "finetune"))},
                {"totalOmegaHome", format_bytes(dir_size(home))}};
    return tool_ok(report.dump(2));
  }

  if (name == "chat_read_cache" || name == "chat_list" ||
      (name == "chat_manage" && (arg_str(args, "action").empty() || arg_str(args, "action") == "list"))) {
    if (!sessions_) return tool_err("sessions unavailable");
    if (name == "chat_read_cache") {
      const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
      if (session_id.empty()) return tool_err("sessionId required");
      const int limit = std::max(1, std::min(100, arg_int(args, "limit", 20)));
      const json msgs = sessions_->get_messages(session_id);
      if (!msgs.is_array()) return tool_ok("[]");
      json slice = json::array();
      const int start = std::max(0, static_cast<int>(msgs.size()) - limit);
      for (size_t i = static_cast<size_t>(start); i < msgs.size(); ++i) slice.push_back(msgs[i]);
      return tool_ok(slice.dump(2));
    }
    return tool_ok(sessions_->list_sessions().dump(2));
  }

  if (name == "chat_manage") {
    if (!sessions_) return tool_err("sessions unavailable");
    const std::string action = lower_copy(arg_str(args, "action", "list"));
    if (action == "list") return tool_ok(sessions_->list_sessions().dump(2));
    if (action == "read") {
      const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
      if (session_id.empty()) return tool_err("sessionId required");
      return tool_ok(sessions_->get_messages(session_id).dump(2));
    }
    if (action == "create") {
      const json row = sessions_->create_session(
          arg_str(args, "title", "New chat"), arg_str(args, "modelId", arg_str(args, "model_id")),
          arg_str(args, "systemPrompt", arg_str(args, "system_prompt")));
      return tool_ok(row.dump(2));
    }
    if (action == "rename") {
      const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
      const std::string title = arg_str(args, "title");
      if (session_id.empty() || title.empty()) return tool_err("sessionId and title required");
      sessions_->update_title(session_id, title);
      return tool_ok("renamed");
    }
    if (action == "delete") {
      const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
      if (session_id.empty()) return tool_err("sessionId required");
      if (!sessions_) return tool_err("sessions unavailable");
      const SessionCleanupDeps cleanup{*sessions_,
                                       projects_,
                                       delivery_,
                                       content_orchestrator_,
                                       content_studio_,
                                       usage_,
                                       media_};
      delete_session_with_cleanup(session_id, cleanup);
      return tool_ok("deleted");
    }
    return tool_err("unknown chat_manage action: " + action);
  }

  if (!plugins_) return tool_err("plugins unavailable");

  if (name == "plugin_catalog") {
    try {
      return tool_ok(plugins_->catalog().dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "search_plugin_catalog") {
    const std::string query = lower_copy(arg_str(args, "query"));
    try {
      json hits = json::array();
      for (const auto& e : plugins_->catalog()) {
        const std::string blob = lower_copy(e.value("id", "") + " " + e.value("name", "") + " " +
                                            e.value("description", ""));
        if (query.empty() || blob.find(query) != std::string::npos) hits.push_back(e);
      }
      return tool_ok(hits.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "install_plugin") {
    const std::string plugin_id = arg_str(args, "pluginId", arg_str(args, "plugin_id"));
    if (plugin_id.empty()) return tool_err("pluginId required");
    try {
      return tool_ok(plugins_->install_builtin(plugin_id).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "reload_plugins") {
    try {
      return tool_ok(plugins_->reload().dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "write_plugin") {
    json input{{"pluginId", arg_str(args, "pluginId", arg_str(args, "plugin_id"))},
               {"name", arg_str(args, "name")},
               {"description", arg_str(args, "description")},
               {"version", arg_str(args, "version", "0.1.0")},
               {"source", arg_str(args, "source")}};
    const std::string tools_json = arg_str(args, "toolsJson", arg_str(args, "tools_json"));
    if (!tools_json.empty()) input["toolsJson"] = tools_json;
    try {
      return tool_ok(plugins_->write_agent_plugin(input).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "create_skill") {
    if (!skills_) return tool_err("skills unavailable");
    const std::string skill_name = arg_str(args, "name");
    const std::string body = arg_str(args, "body");
    if (skill_name.empty() || body.empty()) return tool_err("name and body required");
    json input{{"name", skill_name},
               {"body", body},
               {"description", arg_str(args, "description")},
               {"category", arg_str(args, "category")}};
    const std::string tags = arg_str(args, "tags");
    if (!tags.empty()) input["tags"] = tags;
    try {
      return tool_ok(skills_->save(input).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "record_capability_gap") {
    const std::string goal = arg_str(args, "goal");
    const std::string gap = arg_str(args, "gap");
    if (goal.empty() || gap.empty()) return tool_err("goal and gap required");
    append_capability_gap(goal, gap, arg_str(args, "suggestion"));
    if (memory_) {
      try {
        memory_->add("capability_gap", goal + " — " + gap, arg_str(args, "sessionId"));
      } catch (...) {
      }
    }
    return tool_ok("recorded capability gap");
  }

  if (name == "extend_capability") {
    const std::string goal = arg_str(args, "goal");
    const std::string gap = arg_str(args, "gap");
    if (goal.empty() || gap.empty()) return tool_err("goal and gap required");
    append_capability_gap(goal, gap, arg_str(args, "suggestion"));

    const std::string plugin_id = arg_str(args, "pluginId", arg_str(args, "plugin_id"));
    if (!plugin_id.empty()) {
      try {
        const json installed = plugins_->install_builtin(plugin_id);
        plugins_->reload();
        return tool_ok("Installed plugin " + plugin_id + "\n" + installed.dump(2));
      } catch (const std::exception& e) {
        return tool_err(e.what());
      }
    }

    const std::string source = arg_str(args, "source");
    const std::string tools_json = arg_str(args, "toolsJson", arg_str(args, "tools_json"));
    if (!source.empty() && !tools_json.empty()) {
      json input{{"pluginId", arg_str(args, "pluginId", "agent-ext-" + random_uuid().substr(0, 8))},
                 {"name", arg_str(args, "name", "Agent extension")},
                 {"source", source},
                 {"toolsJson", tools_json}};
      try {
        const json written = plugins_->write_agent_plugin(input);
        plugins_->reload();
        return tool_ok("Wrote plugin\n" + written.dump(2));
      } catch (const std::exception& e) {
        return tool_err(e.what());
      }
    }

    const std::string skill_name = arg_str(args, "skillName", arg_str(args, "skill_name"));
    const std::string skill_body = arg_str(args, "skillBody", arg_str(args, "skill_body"));
    if (!skill_name.empty() && !skill_body.empty() && skills_) {
      try {
        return tool_ok(skills_->save(json{{"name", skill_name}, {"body", skill_body}}).dump(2));
      } catch (const std::exception& e) {
        return tool_err(e.what());
      }
    }

    json hits = json::array();
    const std::string q = lower_copy(gap);
    for (const auto& e : plugins_->catalog()) {
      const std::string blob = lower_copy(e.dump());
      if (blob.find(q) != std::string::npos) hits.push_back(e);
    }
    return tool_ok("Gap recorded. Catalog matches:\n" + hits.dump(2));
  }

  if (name == "finetune_analyze") {
    const std::string model_id = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (model_id.empty()) return tool_err("modelId required");
    return tool_ok(analyze_model_for_finetune(model_id).dump(2));
  }

  if (name == "finetune_prepare_dataset") {
    if (!finetune_datasets_) return tool_err("finetune datasets unavailable");
    json sources = json::array();
    for (const auto& p : split_semicolon_paths(arg_str(args, "sources", arg_str(args, "paths")))) {
      sources.push_back(p);
    }
    json req{{"modality", arg_str(args, "modality", "instruction")}, {"sources", sources}};
    try {
      return tool_ok(finetune_datasets_->prepare_dataset(req).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "finetune_status") {
    if (!finetune_store_) return tool_err("finetune unavailable");
    const std::string job_id = arg_str(args, "jobId", arg_str(args, "job_id"));
    if (job_id.empty()) return tool_ok(finetune_store_->list().dump(2));
    const auto job = finetune_store_->get(job_id);
    if (!job) return tool_err("job not found");
    return tool_ok(job->dump(2));
  }

  if (name == "finetune_stop") {
    if (!finetune_runner_) return tool_err("finetune runner unavailable");
    const std::string job_id = arg_str(args, "jobId", arg_str(args, "job_id"));
    if (job_id.empty()) return tool_err("jobId required");
    finetune_runner_->abort(job_id);
    return tool_ok("aborted " + job_id);
  }

  if (name == "finetune_start") {
    if (!finetune_store_ || !finetune_runner_ || !finetune_datasets_ || !events_) {
      return tool_err("finetune services unavailable");
    }
    const std::string model_id = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (model_id.empty()) return tool_err("modelId required");
    try {
      const std::string modality = arg_str(args, "modality", "instruction");
      json job = finetune_store_->create(json{{"modelId", model_id}, {"modality", modality}});
      const std::string job_id = job.value("id", "");
      const std::string sources_raw = arg_str(args, "sources", arg_str(args, "paths"));
      if (!sources_raw.empty()) {
        json sources = json::array();
        for (const auto& p : split_semicolon_paths(sources_raw)) sources.push_back(p);
        const json prepared =
            finetune_datasets_->prepare_dataset(json{{"modality", modality}, {"sources", sources}});
        job = finetune_store_->update(job_id, json{{"dataset", prepared}});
      }
      const json started = finetune_runner_->start(job_id, *events_);
      return tool_ok(started.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "delegate_to_agent") {
    if (!workforce_) return tool_err("workforce unavailable");
    const std::string agent_id = arg_str(args, "agentId", arg_str(args, "agent_id"));
    const std::string task = arg_str(args, "task");
    if (agent_id.empty() || task.empty()) return tool_err("agentId and task required");
    try {
      return tool_ok(workforce_->delegate_task(agent_id, task).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "run_moa") {
    if (!workforce_) return tool_err("workforce unavailable");
    const std::string task = arg_str(args, "task");
    if (task.empty()) return tool_err("task required");
    try {
      return tool_ok(workforce_->run_moa(task).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "plan_tasks") {
    if (!engine_) return tool_err("engine unavailable");
    const std::string goal = arg_str(args, "goal");
    if (goal.empty()) return tool_err("goal required");
    try {
      engine_->ensure_started();
      const json cfg = config_ ? config_->load() : json::object();
      const std::string model = cfg.value("defaultModel", "");
      json payload{{"model", model},
                   {"messages",
                    json::array({json{{"role", "system"},
                                      {"content", "Return ONLY a JSON array of "
                                                   "{\"agentId\",\"task\"} objects for the goal."}},
                                 json{{"role", "user"}, {"content", goal}}})},
                   {"sampling", json{{"max_tokens", 800}}}};
      const json data = engine_->chat_send(payload, "plan-" + random_uuid(), nullptr, {}, 120000);
      return tool_ok(data.value("text", data.dump(2)));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "download_youtube_audio") {
    const std::string url = arg_str(args, "url");
    if (url.empty()) return tool_err("url required");
    std::string out_dir = arg_str(args, "output_dir");
    if (out_dir.empty()) {
#ifdef _WIN32
      const char* profile = std::getenv("USERPROFILE");
      out_dir = profile ? (std::string(profile) + "\\Music\\Omega Downloads") : "Omega Downloads";
#else
      const char* home = std::getenv("HOME");
      out_dir = home ? (std::string(home) + "/Music/Omega Downloads") : "Omega Downloads";
#endif
    }
    fs::create_directories(out_dir);
    const std::string cmd = "yt-dlp -x --audio-format mp3 -o " +
                            shell_quote(out_dir + "/%(title)s.%(ext)s") + " " + shell_quote(url);
    const std::string raw = capture_command(cmd);
    if (raw.find("ERROR") != std::string::npos || raw.empty()) {
      return tool_err("yt-dlp failed — install yt-dlp (winget install yt-dlp) or use "
                      "install_plugin omega-youtube-dl\n" +
                      raw);
    }
    return tool_ok("Download complete in " + out_dir + "\n" + raw);
  }

  if (name == "run_shell") return run_shell_command(args);

  if (name == "run_process") return run_process_command(args);

  if (name == "browser_stealth_fetch") return run_stealth_fetch(args);

  if (name == "estimate_model_memory") {
    if (!model_meta_) return tool_err("model meta unavailable");
    const std::string model_id = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (model_id.empty()) return tool_err("modelId required");
    try {
      return tool_ok(model_meta_->footprint(model_id).dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "image_generate") {
    if (!projects_ || !config_) return tool_err("image generate unavailable");
    const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
    const std::string prompt = arg_str(args, "prompt");
    const std::string model_arg = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (session_id.empty() || prompt.empty()) return tool_err("sessionId and prompt required");

    const json cfg = config_->load();
    const json img_cfg = cfg.value("imageGeneration", json::object());
    const int width = img_cfg.value("width", 1024);
    const int height = img_cfg.value("height", 1024);

    ImageGenerateResult gen =
        MediaExecutor::generate_image(engine_, cfg, model_arg, prompt, width, height);
    if (!gen.ok) {
      const std::string err =
          gen.error.empty() ? "I couldn't generate that image on this device." : gen.error;
      return tool_err(err);
    }

    projects_->ensure_dir(session_id);
    const fs::path media_dir = fs::path(projects_->open_folder(session_id)) / "media";
    fs::create_directories(media_dir);
    const std::string filename = random_uuid().substr(0, 12) + ".png";
    const fs::path dest = media_dir / filename;
    {
      std::ofstream out(dest, std::ios::binary);
      if (!out) return tool_err("Could not save the generated image to this chat folder.");
      out.write(reinterpret_cast<const char*>(gen.png_bytes.data()),
                static_cast<std::streamsize>(gen.png_bytes.size()));
      if (!out.good()) return tool_err("Could not save the generated image to this chat folder.");
    }
    if (!fs::exists(dest) || fs::file_size(dest) == 0) {
      return tool_err("Image generation finished but the saved file is empty.");
    }
    const std::string ref = filename;
    json part{{"type", "image"}, {"ref", ref}, {"alt", prompt.substr(0, 120)}};
    if (media_) {
      media_->show_preview(json{{"sessionId", session_id}, {"part", part}});
    }
    std::string label = gen.backend;
    if (label == "engine") label = "omega-engine";
    if (gen.studio_fallback) label += " (Content Studio model)";
    else if (gen.ollama_fallback) label += " (Ollama)";
    return tool_ok("[Image: " + ref + "] (" + label + ")", json::array({part}));
  }

  if (name == "audio_generate") {
    return tts_orchestrator_.run_tool(args);
  }

  return tool_err("platform tool not implemented: " + name);
}

std::optional<json> AgentPlatformTools::try_resume_tts_choice(const std::string& session_id,
                                                              const std::string& user_message) {
  return tts_orchestrator_.try_resume_after_choice(session_id, user_message);
}

}  // namespace omega::runtime
