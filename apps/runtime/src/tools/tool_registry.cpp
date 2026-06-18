#include "omega/runtime/tools/tool_registry.hpp"

#include "omega/runtime/debug_log.hpp"
#include "omega/runtime/services/content_studio_orchestrator.hpp"
#include "omega/runtime/services/debug_store.hpp"

#include "omega/runtime/orchestrator/tool_catalog.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/tools/agent_platform_tools.hpp"
#include "omega/runtime/tools/agent_desktop_tools.hpp"
#include "omega/runtime/services/content_studio_orchestrator.hpp"
#include "omega/runtime/services/content_job_delivery_service.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/services/mcp_client_manager.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/tools/plugin_runner.hpp"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <functional>
#include <functional>
#include <iomanip>
#include <regex>
#include <sstream>
#include <sstream>
#include <stdexcept>
#include <vector>

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

std::string resolve_catalog_path() {
  const fs::path candidates[] = {
      fs::path("tool-catalog.json"),
      fs::path("resources") / "tool-catalog.json",
      fs::path("..") / "resources" / "tool-catalog.json",
      fs::path("apps") / "runtime" / "resources" / "tool-catalog.json"};
  for (const auto& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (!ec && fs::exists(abs)) return abs.string();
  }
  return (fs::path("apps") / "runtime" / "resources" / "tool-catalog.json").string();
}

bool is_native_tool(const std::string& name) {
  static const char* k[] = {
      "read_file",     "write_file",    "list_dir",      "delete_file",   "file_info",
      "copy_file",     "move_file",     "grep_files",    "glob_files",    "datetime",
      "math",          "parse_json",    "system_info",   "search_memory", "add_memory",
      "search_docs",   "list_skills",   "read_skill",    "list_tools"};
  for (const char* n : k) {
    if (name == n) return true;
  }
  return false;
}

std::string normalize_write_file_path(std::string path) {
  if (path.empty()) return path;
  while (!path.empty() && (path.front() == '/' || path.front() == '\\')) path.erase(path.begin());
  const fs::path p(path);
  if (p.empty()) return path;
  const fs::path parent = p.parent_path();
  if (parent.empty() || parent == "." || parent == fs::path("/") || parent == fs::path("\\")) {
    const std::string ext = p.extension().string();
    if (ext == ".py" || ext == ".js" || ext == ".ts" || ext == ".tsx" || ext == ".sh" ||
        ext == ".ps1" || ext == ".html" || ext == ".css" || ext == ".json" || ext == ".md") {
      return (fs::path("code") / p.filename()).generic_string();
    }
  }
  return p.generic_string();
}

std::string first_nonempty_arg(const std::map<std::string, std::string>& args,
                               std::initializer_list<const char*> keys) {
  for (const char* key : keys) {
    const auto it = args.find(key);
    if (it != args.end() && !it->second.empty()) return it->second;
  }
  return "";
}

std::string infer_write_file_path(const std::map<std::string, std::string>& args,
                                  const std::string& content) {
  std::string ext = ".txt";
  if (!content.empty()) {
    std::string head = content.substr(0, std::min(content.size(), size_t(512)));
    for (char& c : head) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (head.find("<!doctype") != std::string::npos || head.find("<html") != std::string::npos) {
      ext = ".html";
    } else if (head.find("#!/") == 0 || head.find("def ") != std::string::npos ||
               head.find("import ") != std::string::npos) {
      ext = ".py";
    } else if (head.find("function ") != std::string::npos ||
               head.find("const ") != std::string::npos) {
      ext = ".js";
    }
  }

  std::string slug = "output";
  const std::string user = first_nonempty_arg(args, {"user_message", "message", "query"});
  if (!user.empty()) {
    static const std::regex word_re(R"([a-zA-Z][a-zA-Z0-9]{2,})");
    std::vector<std::string> words;
    for (std::sregex_iterator it(user.begin(), user.end(), word_re), end; it != end; ++it) {
      std::string w = (*it)[1].str();
      for (char& c : w) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      static const std::regex skip(
          "^(write|create|make|single|file|html|game|clone|script|code|test|run|please|the|and|one|a|an)$",
          std::regex_constants::icase);
      if (std::regex_match(w, skip)) continue;
      words.push_back(w);
      if (words.size() >= 3) break;
    }
    if (!words.empty()) {
      slug = words[0];
      for (size_t i = 1; i < words.size(); ++i) slug += "-" + words[i];
    }
  }
  return (fs::path("code") / (slug + ext)).generic_string();
}

struct ResolvedWriteFileArgs {
  std::string path;
  std::string content;
  std::string error;
};

ResolvedWriteFileArgs resolve_write_file_args(const std::map<std::string, std::string>& args) {
  ResolvedWriteFileArgs out;
  out.path = first_nonempty_arg(args, {"path", "filePath", "file_path", "filepath", "filename",
                                       "file", "target", "dest", "name"});
  out.content = first_nonempty_arg(args, {"content", "text", "body", "data", "html", "source",
                                          "code", "contents"});
  if (out.path.empty() && !out.content.empty()) {
    out.path = infer_write_file_path(args, out.content);
  }
  if (out.path.empty()) {
    out.error =
        "path is required — include path (e.g. code/asteroids.html) and content in write_file args.";
    return out;
  }
  if (out.content.empty()) {
    out.error = "content is required for write_file.";
    return out;
  }
  return out;
}

int arg_int(const std::map<std::string, std::string>& args, const std::string& key, int fallback) {
  const auto it = args.find(key);
  if (it == args.end()) return fallback;
  try {
    return std::stoi(it->second);
  } catch (...) {
    return fallback;
  }
}

std::string arg_str(const std::map<std::string, std::string>& args, const std::string& key,
                    const std::string& fallback = "") {
  const auto it = args.find(key);
  return it == args.end() ? fallback : it->second;
}

bool path_needs_host(const Sandbox& sb, const std::string& path) {
  if (path.empty()) return false;
  return !sb.path_in_sandbox(path);
}

bool tool_paths_need_host(const std::string& name, const std::map<std::string, std::string>& args,
                          const Sandbox& sb) {
  if (name == "read_file" || name == "write_file" || name == "list_dir" || name == "delete_file" ||
      name == "file_info") {
    return path_needs_host(sb, arg_str(args, "path", "."));
  }
  if (name == "copy_file" || name == "move_file") {
    const std::string src = arg_str(args, "src", arg_str(args, "from"));
    const std::string dest = arg_str(args, "dest", arg_str(args, "to"));
    return path_needs_host(sb, src) || path_needs_host(sb, dest);
  }
  if (name == "grep_files" || name == "glob_files") {
    return path_needs_host(sb, arg_str(args, "path", "."));
  }
  return false;
}

double eval_math_expr(const std::string& expr, bool& ok) {
  ok = false;
  std::string s = expr;
  for (char& c : s) {
    if (!(std::isdigit(static_cast<unsigned char>(c)) || c == '+' || c == '-' || c == '*' ||
          c == '/' || c == '.' || c == '(' || c == ')' || c == '%' || c == ' ' || c == '^')) {
      return 0;
    }
  }
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '^') s.replace(i, 1, "**"), ++i;
  }
  size_t pos = 0;
  std::function<double()> parse_expr;
  std::function<double()> parse_term;
  std::function<double()> parse_factor;
  parse_factor = [&]() -> double {
    while (pos < s.size() && s[pos] == ' ') ++pos;
    if (pos < s.size() && s[pos] == '(') {
      ++pos;
      const double v = parse_expr();
      if (pos < s.size() && s[pos] == ')') ++pos;
      return v;
    }
    size_t start = pos;
    while (pos < s.size() && (std::isdigit(static_cast<unsigned char>(s[pos])) || s[pos] == '.'))
      ++pos;
    if (start == pos) throw std::runtime_error("bad number");
    return std::stod(s.substr(start, pos - start));
  };
  parse_term = [&]() -> double {
    double v = parse_factor();
    while (true) {
      while (pos < s.size() && s[pos] == ' ') ++pos;
      if (pos + 1 < s.size() && s[pos] == '*' && s[pos + 1] == '*') {
        pos += 2;
        v = std::pow(v, parse_factor());
      } else if (pos < s.size() && (s[pos] == '*' || s[pos] == '/')) {
        const char op = s[pos++];
        const double r = parse_factor();
        v = op == '*' ? v * r : v / r;
      } else {
        break;
      }
    }
    return v;
  };
  parse_expr = [&]() -> double {
    double v = parse_term();
    while (true) {
      while (pos < s.size() && s[pos] == ' ') ++pos;
      if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) {
        const char op = s[pos++];
        const double r = parse_term();
        v = op == '+' ? v + r : v - r;
      } else {
        break;
      }
    }
    return v;
  };
  try {
    const double v = parse_expr();
    ok = true;
    return v;
  } catch (...) {
    return 0;
  }
}

json json_at_path(const json& root, const std::string& dotted) {
  json cur = root;
  std::istringstream in(dotted);
  std::string part;
  while (std::getline(in, part, '.')) {
    if (part.empty()) continue;
    if (!cur.is_object() || !cur.contains(part)) return nullptr;
    cur = cur[part];
  }
  return cur;
}

bool parse_mcp_tool_name(const std::string& name, std::string& server_id, std::string& tool_name) {
  const std::string prefix = "mcp:";
  if (name.rfind(prefix, 0) != 0) return false;
  const size_t rest = prefix.size();
  const size_t colon = name.find(':', rest);
  if (colon == std::string::npos) return false;
  server_id = name.substr(rest, colon - rest);
  tool_name = name.substr(colon + 1);
  return !server_id.empty() && !tool_name.empty();
}

bool parse_plugin_tool_name(const std::string& name, std::string& plugin_id, std::string& tool_name) {
  if (name.rfind("mcp:", 0) == 0) return false;
  const size_t colon = name.find(':');
  if (colon == std::string::npos || colon == 0) return false;
  plugin_id = name.substr(0, colon);
  tool_name = name.substr(colon + 1);
  return !plugin_id.empty() && !tool_name.empty();
}

ToolResult search_files_in_dir(const std::string& root, const std::string& pattern, int max_files) {
  ToolResult out{true, "", json::array()};
  if (!fs::exists(root)) return ToolResult{false, "path not found: " + root, json::array()};
  std::ostringstream lines;
  int count = 0;
  const std::string pat_lower = pattern;
  std::function<void(const fs::path&)> walk = [&](const fs::path& dir) {
    if (count >= max_files) return;
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
      if (count >= max_files) return;
      if (entry.is_directory()) {
        walk(entry.path());
      } else if (entry.is_regular_file()) {
        const std::string fname = entry.path().filename().string();
        if (pattern.empty() ||
            fname.find(pattern) != std::string::npos) {
          lines << entry.path().string() << '\n';
          ++count;
        }
      }
    }
  };
  walk(fs::path(root));
  out.output = lines.str();
  while (!out.output.empty() && out.output.back() == '\n') out.output.pop_back();
  return out;
}

}  // namespace

ToolRegistry::ToolRegistry(ConfigStore& config, ProfileContext& profile, MemoryStore& memory,
                           RagStore& rag, SkillsStore& skills, McpClientManager& mcp,
                           PluginStore& plugins)
    : config_(config),
      profile_(profile),
      memory_(memory),
      rag_(rag),
      skills_(skills),
      mcp_(mcp),
      plugins_(plugins) {
  load_catalog();
}

void ToolRegistry::load_catalog() {
  catalog_.clear();
  const std::string path = resolve_catalog_path();
  if (!fs::exists(path)) return;
  try {
    std::ifstream in(path);
    const json root = json::parse(in);
    if (!root.contains("tools") || !root["tools"].is_array()) return;
    for (const auto& t : root["tools"]) {
      CatalogEntry e;
      e.name = t.value("name", "");
      e.description = t.value("description", "");
      e.enabled = t.value("enabled", true);
      e.source = t.value("source", "builtin");
      e.needs_approval = t.value("needsApproval", false);
      if (!e.name.empty()) catalog_.push_back(std::move(e));
    }
  } catch (...) {
    catalog_.clear();
  }
}

std::string ToolRegistry::sandbox_root() const {
  const json cfg = config_.load();
  std::string root = cfg.value("sandboxRoot", "");
  if (root.empty()) root = (fs::path(profile_.profile_home()) / "workspace").string();
  fs::create_directories(root);
  return fs::absolute(root).string();
}

Sandbox ToolRegistry::make_sandbox() const { return Sandbox(sandbox_root()); }

Sandbox ToolRegistry::make_sandbox_for(const std::map<std::string, std::string>& args) const {
  std::string root = sandbox_root();
  if (projects_) {
    const auto it = args.find("sessionId");
    const auto it2 = args.find("session_id");
    const std::string session_id =
        it != args.end() ? it->second : (it2 != args.end() ? it2->second : "");
    if (!session_id.empty()) {
      try {
        root = projects_->ensure_dir(session_id);
      } catch (...) {
      }
    }
  }
  return Sandbox(fs::absolute(root).string());
}

std::map<std::string, std::string> ToolRegistry::args_map(const json& args) const {
  std::map<std::string, std::string> out;
  if (args.is_object()) {
    for (auto it = args.begin(); it != args.end(); ++it) {
      if (it.value().is_string()) out[it.key()] = it.value().get<std::string>();
      else out[it.key()] = it.value().dump();
    }
  }
  return out;
}

bool ToolRegistry::is_enabled(const CatalogEntry& entry) const {
  const auto it = toggles_.find(entry.name);
  if (it != toggles_.end()) return it->second;
  return entry.enabled;
}

const ToolRegistry::CatalogEntry* ToolRegistry::find_entry(const std::string& name) const {
  for (const auto& e : catalog_) {
    if (e.name == name) return &e;
  }
  return nullptr;
}

json ToolRegistry::result_json(const ToolResult& r) const {
  json out{{"ok", r.ok}, {"output", r.output}};
  if (!r.parts.empty()) out["parts"] = r.parts;
  return out;
}

json ToolRegistry::list() {
  json arr = json::array();
  for (const auto& e : catalog_) {
    arr.push_back({{"name", e.name},
                   {"description", e.description},
                   {"enabled", is_enabled(e)},
                   {"source", e.source},
                   {"needsApproval", e.needs_approval}});
  }
  for (const auto& t : mcp_.all_tools()) {
    if (!t.is_object()) continue;
    const bool enabled = toggles_.contains(t.value("name", ""))
                             ? toggles_.at(t.value("name", ""))
                             : true;
    arr.push_back({{"name", t.value("name", "")},
                   {"description", t.value("description", "")},
                   {"enabled", enabled},
                   {"source", "mcp"},
                   {"needsApproval", true}});
  }
  for (const auto& t : plugins_.plugin_tools()) {
    if (!t.is_object()) continue;
    const std::string name = t.value("name", "");
    const bool enabled =
        toggles_.contains(name) ? toggles_.at(name) : t.value("enabled", true);
    arr.push_back({{"name", name},
                   {"description", t.value("description", "")},
                   {"enabled", enabled},
                   {"source", "plugin"},
                   {"needsApproval", false}});
  }
  return arr;
}

void ToolRegistry::toggle(const std::string& name, bool enabled) { toggles_[name] = enabled; }

void ToolRegistry::attach_content_services(ContentStudioSupervisor* content_studio,
                                           ContentJobDeliveryService* delivery,
                                           SessionStore* sessions, EventBus* events) {
  content_studio_ = content_studio;
  content_delivery_ = delivery;
  sessions_ = sessions;
  events_ = events;
}

void ToolRegistry::attach_content_orchestrator(ContentStudioOrchestrator* orchestrator) {
  content_orchestrator_ = orchestrator;
}

std::optional<nlohmann::json> ToolRegistry::try_resume_content_briefing_choice(
    const std::string& session_id, const std::string& user_message) {
  if (!content_orchestrator_) return std::nullopt;
  return content_orchestrator_->try_resume_after_briefing_choice(session_id, user_message);
}

std::optional<nlohmann::json> ToolRegistry::try_resume_content_gpu_choice(
    const std::string& session_id, const std::string& user_message) {
  if (!content_orchestrator_) return std::nullopt;
  return content_orchestrator_->try_resume_after_gpu_choice(session_id, user_message);
}

std::optional<nlohmann::json> ToolRegistry::try_resume_tts_choice(const std::string& session_id,
                                                                  const std::string& user_message) {
  if (!agent_platform_) return std::nullopt;
  return agent_platform_->try_resume_tts_choice(session_id, user_message);
}

void ToolRegistry::attach_agent_desktop_tools(AgentDesktopTools* desktop_tools) {
  agent_desktop_ = desktop_tools;
}

void ToolRegistry::attach_agent_platform_tools(AgentPlatformTools* platform_tools) {
  agent_platform_ = platform_tools;
}

void ToolRegistry::attach_project_store(ProjectStore* projects) { projects_ = projects; }

void ToolRegistry::attach_debug(DebugStore* debug) { debug_ = debug; }

json ToolRegistry::run_content_tool(const std::string& name,
                                    const std::map<std::string, std::string>& args) {
  if (content_orchestrator_) return content_orchestrator_->run_tool(name, args);
  if (!content_studio_) {
    return json{{"ok", false}, {"output", "Content Studio unavailable in native runtime"}};
  }
  return json{{"ok", false}, {"output", "content tool not implemented natively: " + name}};
}

json ToolRegistry::run_native(const std::string& name,
                              const std::map<std::string, std::string>& args) {
  const Sandbox sb = make_sandbox_for(args);
  const bool host_allowed = config_.load().value("allowHostFilesystem", false);

  auto host_or_sandbox_read = [&](const std::string& path) -> ToolResult {
    if (sb.path_in_sandbox(path)) return sb.fs_read(path);
    if (!host_allowed) {
      return ToolResult{false,
                        "Host filesystem access required for paths outside the session workspace. "
                        "Enable in Settings → Permissions or approve when prompted.",
                        json::array()};
    }
    return sb.host_fs_read(path);
  };
  auto host_or_sandbox_write = [&](const std::string& path, const std::string& content) -> ToolResult {
    if (sb.path_in_sandbox(path)) return sb.fs_write(normalize_write_file_path(path), content);
    if (!host_allowed) {
      return ToolResult{false,
                        "Host filesystem access required for paths outside the session workspace.",
                        json::array()};
    }
    return sb.host_fs_write(path, content);
  };
  auto host_or_sandbox_list = [&](const std::string& path) -> ToolResult {
    if (sb.path_in_sandbox(path)) return sb.fs_list(path);
    if (!host_allowed) {
      return ToolResult{false,
                        "Host filesystem access required for paths outside the session workspace.",
                        json::array()};
    }
    return sb.host_fs_list(path);
  };
  auto host_or_sandbox_delete = [&](const std::string& path) -> ToolResult {
    if (sb.path_in_sandbox(path)) return sb.fs_delete(path);
    if (!host_allowed) {
      return ToolResult{false,
                        "Host filesystem access required for paths outside the session workspace.",
                        json::array()};
    }
    return sb.host_fs_delete(path);
  };
  auto host_or_sandbox_stat = [&](const std::string& path) -> ToolResult {
    if (sb.path_in_sandbox(path)) return sb.fs_stat(path);
    if (!host_allowed) {
      return ToolResult{false,
                        "Host filesystem access required for paths outside the session workspace.",
                        json::array()};
    }
    return sb.host_fs_stat(path);
  };

  if (name == "read_file") return result_json(host_or_sandbox_read(arg_str(args, "path")));
  if (name == "write_file") {
    const ResolvedWriteFileArgs resolved = resolve_write_file_args(args);
    if (!resolved.error.empty()) {
      return result_json(ToolResult{false, resolved.error, json::array()});
    }
    return result_json(host_or_sandbox_write(normalize_write_file_path(resolved.path),
                                           resolved.content));
  }
  if (name == "list_dir") return result_json(host_or_sandbox_list(arg_str(args, "path", ".")));
  if (name == "delete_file") return result_json(host_or_sandbox_delete(arg_str(args, "path")));
  if (name == "file_info") return result_json(host_or_sandbox_stat(arg_str(args, "path")));
  if (name == "copy_file") {
    const std::string src = arg_str(args, "src", arg_str(args, "from"));
    const std::string dest = arg_str(args, "dest", arg_str(args, "to"));
    if (sb.path_in_sandbox(src) && sb.path_in_sandbox(dest)) return result_json(sb.fs_copy(src, dest));
    if (!host_allowed) {
      return result_json(ToolResult{false,
                                    "Host filesystem access required for paths outside the session "
                                    "workspace.",
                                    json::array()});
    }
    return result_json(sb.host_fs_copy(src, dest));
  }
  if (name == "move_file") {
    const std::string src = arg_str(args, "src", arg_str(args, "from"));
    const std::string dest = arg_str(args, "dest", arg_str(args, "to"));
    if (sb.path_in_sandbox(src) && sb.path_in_sandbox(dest)) return result_json(sb.fs_move(src, dest));
    if (!host_allowed) {
      return result_json(ToolResult{false,
                                    "Host filesystem access required for paths outside the session "
                                    "workspace.",
                                    json::array()});
    }
    return result_json(sb.host_fs_move(src, dest));
  }
  if (name == "grep_files") {
    const std::string sub = arg_str(args, "path", ".");
    if (sb.path_in_sandbox(sub)) {
      return result_json(sb.grep_project(arg_str(args, "pattern"), sub, arg_int(args, "max_files", 40),
                                         arg_int(args, "max_matches", 60)));
    }
    if (!host_allowed) {
      return result_json(ToolResult{false,
                                    "Host filesystem access required for paths outside the session "
                                    "workspace.",
                                    json::array()});
    }
    return result_json(sb.host_grep(arg_str(args, "pattern"), sub, arg_int(args, "max_files", 40),
                                    arg_int(args, "max_matches", 60)));
  }
  if (name == "glob_files") {
    const std::string sub = arg_str(args, "path", ".");
    if (sb.path_in_sandbox(sub)) {
      return result_json(sb.glob_project(arg_str(args, "pattern"), sub));
    }
    if (!host_allowed) {
      return result_json(ToolResult{false,
                                    "Host filesystem access required for paths outside the session "
                                    "workspace.",
                                    json::array()});
    }
    return result_json(sb.host_glob(arg_str(args, "pattern"), sub));
  }
  if (name == "datetime") {
    const std::string tz = arg_str(args, "tz");
    const auto now = std::chrono::system_clock::now();
    const std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm local{};
#ifdef _WIN32
    localtime_s(&local, &t);
#else
    localtime_r(&t, &local);
#endif
    std::ostringstream oss;
    oss << std::put_time(&local, "%A %d %B %Y %H:%M:%S");
    const int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch())
                           .count();
    const std::string zone = tz.empty() ? "local" : tz;
    return result_json(ToolResult{true, oss.str() + " (timezone: " + zone + ", epoch ms: " +
                                          std::to_string(ms) + ")",
                                  json::array()});
  }
  if (name == "math") {
    bool ok_eval = false;
    const double v = eval_math_expr(arg_str(args, "expr"), ok_eval);
    if (!ok_eval) return result_json(ToolResult{false, "invalid expression", json::array()});
    return result_json(ToolResult{true, std::to_string(v), json::array()});
  }
  if (name == "parse_json") {
    try {
      const json obj = json::parse(arg_str(args, "text"));
      const std::string path = arg_str(args, "path");
      if (path.empty()) return result_json(ToolResult{true, obj.dump(2), json::array()});
      const json cur = json_at_path(obj, path);
      if (cur.is_string()) return result_json(ToolResult{true, cur.get<std::string>(), json::array()});
      return result_json(ToolResult{true, cur.dump(2), json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "system_info") {
#ifdef _WIN32
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    MEMORYSTATUSEX mem{};
    mem.dwLength = sizeof(mem);
    GlobalMemoryStatusEx(&mem);
    char hostname[256]{};
    DWORD sz = sizeof(hostname);
    GetComputerNameA(hostname, &sz);
    json info{{"platform", "win32"},
              {"arch", si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x64" : "other"},
              {"cpus", static_cast<int>(si.dwNumberOfProcessors)},
              {"totalMemoryGb", mem.ullTotalPhys / (1024.0 * 1024 * 1024)},
              {"freeMemoryGb", mem.ullAvailPhys / (1024.0 * 1024 * 1024)},
              {"hostname", hostname}};
#else
    json info{{"platform", "unix"}};
#endif
    return result_json(ToolResult{true, info.dump(2), json::array()});
  }
  if (name == "search_memory") {
    try {
      const json hits = memory_.search(arg_str(args, "query"));
      std::ostringstream out;
      if (hits.is_array()) {
        for (const auto& h : hits) {
          out << "- [" << h.value("kind", "") << "] " << h.value("content", "") << '\n';
        }
      }
      const std::string text = out.str();
      return result_json(ToolResult{true, text.empty() ? "(no hits)" : text, json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "add_memory") {
    try {
      const std::string kind = arg_str(args, "kind", "fact");
      const json row = memory_.add(kind, arg_str(args, "content"), arg_str(args, "sessionId"));
      return result_json(ToolResult{true, "saved memory " + row.value("id", ""), json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "search_docs") {
    try {
      const json hits = rag_.search(arg_str(args, "query"));
      std::ostringstream out;
      if (hits.is_array()) {
        for (const auto& h : hits) {
          out << "# " << h.value("source", "") << "#" << h.value("chunkIdx", 0) << " (score "
              << h.value("score", 0.f) << ")\n"
              << h.value("content", "") << "\n\n---\n\n";
        }
      }
      const std::string text = out.str();
      return result_json(ToolResult{true, text.empty() ? "(no hits)" : text, json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "list_skills") {
    try {
      return result_json(ToolResult{true, skills_.list().dump(2), json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "read_skill") {
    try {
      return result_json(ToolResult{true, skills_.get(arg_str(args, "skillId", arg_str(args, "id"))).dump(2),
                                    json::array()});
    } catch (const std::exception& e) {
      return result_json(ToolResult{false, e.what(), json::array()});
    }
  }
  if (name == "list_tools") {
    return result_json(ToolResult{true, list().dump(2), json::array()});
  }
  return json{{"ok", false}, {"output", "native handler missing: " + name}};
}

json ToolRegistry::run_plugin_tool(const std::string& name, const json& args) {
  std::string plugin_id;
  std::string tool_name;
  if (!parse_plugin_tool_name(name, plugin_id, tool_name)) {
    return json{{"ok", false}, {"output", "invalid plugin tool: " + name}};
  }
  if (!plugins_.is_plugin_tool(name)) {
    return json{{"ok", false}, {"output", "unknown plugin tool: " + name}};
  }

  const auto args_s = args_map(args.is_object() ? args : json::object());
  const Sandbox sb = make_sandbox();

  if (plugin_id == "omega-hello" && tool_name == "hello") {
    const std::string who = arg_str(args_s, "name", "world");
    return result_json(ToolResult{true, "Hello, " + who + "!", json::array()});
  }
  if (plugin_id == "omega-fs-ext") {
    if (tool_name == "copy_file") {
      const std::string src = arg_str(args_s, "from", arg_str(args_s, "src"));
      const std::string dest = arg_str(args_s, "to", arg_str(args_s, "dest"));
      return result_json(sb.fs_copy(src, dest));
    }
    if (tool_name == "move_file") {
      const std::string src = arg_str(args_s, "from", arg_str(args_s, "src"));
      const std::string dest = arg_str(args_s, "to", arg_str(args_s, "dest"));
      return result_json(sb.fs_move(src, dest));
    }
    if (tool_name == "search_files") {
      const std::string root = arg_str(args_s, "path", ".");
      const std::string pattern = arg_str(args_s, "pattern");
      return result_json(search_files_in_dir(root, pattern, 200));
    }
  }

  const fs::path plugin_dir = fs::path(plugins_dir()) / plugin_id;
  if (fs::exists(plugin_dir / "index.js")) {
    try {
      return invoke_plugin_tool(plugin_dir.string(), tool_name, args.is_object() ? args : json::object());
    } catch (const std::exception& e) {
      return json{{"ok", false}, {"output", e.what()}};
    }
  }

  return run_unavailable_tool(name, args_s);
}

json ToolRegistry::run_mcp_tool(const std::string& name, const json& args) {
  std::string server_id;
  std::string tool_name;
  if (!parse_mcp_tool_name(name, server_id, tool_name)) {
    return json{{"ok", false}, {"output", "invalid mcp tool: " + name}};
  }
  try {
    return mcp_.call_tool(server_id, tool_name, args);
  } catch (const std::exception& e) {
    return json{{"ok", false}, {"output", e.what()}};
  }
}

json ToolRegistry::run_unavailable_tool(const std::string& name,
                                    const std::map<std::string, std::string>& args) {
  (void)args;
  return json{{"ok", false},
              {"output", "Tool not available in native runtime: " + name}};
}

json ToolRegistry::run(const std::string& name_in, const json& args_in) {
  const std::string name = normalize_orchestrator_tool_name(name_in);
  const json args = args_in.is_object() ? args_in : json::object();
  emit_debug(debug_, "tools", "run " + name, "info", json{{"tool", name}});

  if (name.starts_with("mcp:")) {
    json cfg = config_.load();
    if (!approvals_.require_tool_approval(name, args, cfg)) {
      const std::string err = approvals_.last_tool_approval_error();
      return json{{"ok", false},
                  {"output", err.empty() ? "Tool approval not granted." : err}};
    }
    return run_mcp_tool(name, args);
  }

  if (plugins_.is_plugin_tool(name)) {
    const bool enabled = toggles_.contains(name) ? toggles_.at(name) : true;
    if (!enabled) return json{{"ok", false}, {"output", "tool disabled: " + name}};
    return run_plugin_tool(name, args);
  }

  const auto args_s = args_map(args);
  const CatalogEntry* entry = find_entry(name);

  if (!entry) return json{{"ok", false}, {"output", "unknown tool: " + name}};
  if (!is_enabled(*entry)) return json{{"ok", false}, {"output", "tool disabled: " + name}};

  json cfg = config_.load();
  const Sandbox sb_preview = make_sandbox_for(args_s);
  if (tool_paths_need_host(name, args_s, sb_preview)) {
    const auto save = [this](const json& patch) { return config_.save_patch(patch); };
    if (!approvals_.require_capability("host_filesystem", name, args, cfg, save)) {
      const std::string err = approvals_.last_capability_error();
      return json{{"ok", false},
                  {"output", err.empty()
                                 ? "Host filesystem access not granted. Enable in Settings → "
                                   "Permissions or approve when prompted."
                                 : err}};
    }
    cfg = config_.load();
  }
  if (const auto cap = capability_for_tool(name)) {
    const auto save = [this](const json& patch) { return config_.save_patch(patch); };
    if (!approvals_.require_capability(*cap, name, args, cfg, save)) {
      const std::string err = approvals_.last_capability_error();
      return json{{"ok", false},
                  {"output", err.empty() ? "Permission not granted for capability: " + *cap : err}};
    }
    cfg = config_.load();
  }
  if (entry->needs_approval) {
    if (!approvals_.require_tool_approval(name, args, cfg)) {
      const std::string err = approvals_.last_tool_approval_error();
      return json{{"ok", false},
                  {"output", err.empty() ? "Tool approval not granted." : err}};
    }
  }

  if (name.starts_with("content_") && content_studio_) {
    return run_content_tool(name, args_s);
  }

  if (agent_desktop_ && agent_desktop_->handles(name)) {
    return agent_desktop_->run(name, args_s);
  }

  if (agent_platform_ && agent_platform_->handles(name)) {
    return agent_platform_->run(name, args_s);
  }

  json result;
  if (is_native_tool(name)) {
    result = run_native(name, args_s);
  } else {
    result = run_unavailable_tool(name, args_s);
  }
  if (!result.value("ok", false)) {
    emit_debug(debug_, "tools", "run " + name + " failed", "warn",
               json{{"tool", name}, {"output", result.value("output", "")}});
  }
  return result;
}

bool ToolRegistry::resolve_capability_permission(const std::string& id, bool approved,
                                                 bool remember) {
  const auto save = [this](const json& patch) { return config_.save_patch(patch); };
  return approvals_.resolve_capability(id, approved, remember, save);
}

}  // namespace omega::runtime
