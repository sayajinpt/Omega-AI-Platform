#include "omega/runtime/tools/tool_approval.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <map>
#include <regex>
#include <set>
#include <vector>

namespace omega::runtime {

namespace {

struct CapabilityMeta {
  const char* label;
  const char* summary;
  const char* detail;
  const char* settings_hint;
  const char* config_key;
};

const CapabilityMeta* capability_meta(const std::string& capability) {
  static const std::map<std::string, CapabilityMeta> kMeta{
      {"web_fetch",
       {"Web fetch", "Allow HTTP requests and web search from the agent",
        "The agent wants to fetch a URL or search the web. This sends network traffic from your PC.",
        "Settings → Permissions → Allow web fetch tools", "allowWebFetch"}},
      {"browser",
       {"Browser automation", "Allow in-app browser and browser_* tools",
        "The agent wants to navigate web pages, take snapshots, or run stealth fetch scripts.",
        "Settings → Permissions → Browser automation", "allowBrowser"}},
      {"shell",
       {"Shell & processes", "Allow run_shell and run_process on your system",
        "The agent wants to run shell commands or launch programs. Commands run as your Windows user.",
        "Settings → Permissions → Allow shell tool", "allowShell"}},
      {"host_filesystem",
       {"Host filesystem", "Allow file tools outside the session workspace",
        "The agent wants to read or write files using an absolute path (or a path outside the chat "
        "project folder). This can access any file your user account can reach.",
        "Settings → Permissions → Host filesystem access", "allowHostFilesystem"}},
      {"finetune",
       {"Fine-tune jobs", "Allow finetune_* agent tools",
        "The agent wants to start or manage a local fine-tune job.",
        "Settings → Permissions → Fine-tune jobs", "allowFinetune"}},
      {"content_studio",
       {"Content Studio", "Allow content_* media generation tools",
        "The agent wants to run Content Studio (TTS, video, image pipelines).",
        "Settings → Permissions → Content Studio", "allowContentStudio"}}};
  const auto it = kMeta.find(capability);
  return it == kMeta.end() ? nullptr : &it->second;
}

nlohmann::json capability_permission_payload(const std::string& id, const std::string& capability,
                                             const std::string& tool, const nlohmann::json& args) {
  nlohmann::json payload{{"id", id}, {"capability", capability}, {"tool", tool}, {"args", args}};
  if (const CapabilityMeta* meta = capability_meta(capability)) {
    payload["label"] = meta->label;
    payload["summary"] = meta->summary;
    payload["detail"] = meta->detail;
    payload["settingsHint"] = meta->settings_hint;
  }
  return payload;
}

}  // namespace

namespace {

bool config_has_trusted_tool(const nlohmann::json& config, const std::string& tool) {
  if (!config.contains("trustedTools") || !config["trustedTools"].is_array()) return false;
  for (const auto& t : config["trustedTools"]) {
    if (t.is_string() && t.get<std::string>() == tool) return true;
  }
  return false;
}

const std::set<std::string>& autonomous_tools() {
  static const std::set<std::string> k{
      "inference_status", "list_models",      "load_model",          "unload_model",
      "estimate_model_memory", "content_create_run", "content_run_status",
      "content_list_projects", "content_series_list", "content_schedule_list"};
  return k;
}

const std::set<std::string>& sensitive_tools() {
  static const std::set<std::string> k{
      "run_python",           "shell",           "run_shell",
      "run_process",      "exec",                 "fs_write",        "fs_delete",
      "write_file",       "edit_file",            "delete_file",     "http_request",
      "web_fetch",        "browser_navigate",     "browser_snapshot", "browser_stealth_fetch",
      "finetune_prepare_dataset", "finetune_start", "finetune_stop", "content_delete_project",
      "content_storage_cleanup",  "copy_file",      "move_file",     "download_youtube_audio",
      "web_search"};
  return k;
}

const std::vector<std::regex>& dangerous_patterns() {
  static const std::vector<std::regex> k{
      std::regex(R"(\brm\s+-rf\b)", std::regex_constants::icase),
      std::regex(R"(\bsudo\b)", std::regex_constants::icase),
      std::regex(R"(\bdd\s+if=)", std::regex_constants::icase),
      std::regex(R"(\bmkfs\b)", std::regex_constants::icase),
      std::regex(R"(\bformat\s+[a-z]:)", std::regex_constants::icase),
      std::regex(R"(\bshutdown\b)", std::regex_constants::icase),
      std::regex(R"(\breboot\b)", std::regex_constants::icase),
      std::regex(R"(\bchmod\s+-R\s+777\b)", std::regex_constants::icase),
      std::regex(R"(\bcurl\s+[^|]+\|\s*sh\b)", std::regex_constants::icase),
      std::regex(R"(\bwget\s+[^|]+\|\s*(sh|bash)\b)", std::regex_constants::icase)};
  return k;
}

std::string args_blob(const std::string& tool, const nlohmann::json& args) {
  std::string blob = tool;
  if (args.is_object()) {
    for (auto it = args.begin(); it != args.end(); ++it) {
      blob += ' ';
      if (it.value().is_string()) blob += it.value().get<std::string>();
      else blob += it.value().dump();
    }
  }
  return blob;
}

}  // namespace

bool is_dangerous_tool(const std::string& tool, const nlohmann::json& args) {
  const std::string blob = args_blob(tool, args);
  for (const auto& re : dangerous_patterns()) {
    if (std::regex_search(blob, re)) return true;
  }
  return false;
}

std::optional<std::string> capability_for_tool(const std::string& tool) {
  if (tool.starts_with("browser_")) return "browser";
  if (tool == "web_fetch" || tool == "web_search" || tool == "http_request") return "web_fetch";
  if (tool == "run_shell" || tool == "run_process") return "shell";
  if (tool.starts_with("finetune_")) return "finetune";
  if (tool.starts_with("content_")) return "content_studio";
  if (tool == "browser_stealth_fetch") return "browser";
  return std::nullopt;
}

bool is_capability_enabled(const std::string& capability, const nlohmann::json& config) {
  if (capability == "web_fetch") return config.value("allowWebFetch", false);
  if (capability == "browser") return config.value("allowBrowser", true);
  if (capability == "shell") return config.value("allowShell", false);
  if (capability == "host_filesystem") return config.value("allowHostFilesystem", false);
  if (capability == "finetune") return config.value("allowFinetune", true);
  if (capability == "content_studio") return config.value("allowContentStudio", true);
  return false;
}

bool ToolApprovalGate::wait_for_tool(const std::string& id, int timeout_ms) {
  std::unique_lock lock(mu_);
  return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&] {
    return tool_results_.contains(id);
  }) && tool_results_[id];
}

bool ToolApprovalGate::wait_for_capability(const std::string& id, int timeout_ms) {
  std::unique_lock lock(mu_);
  return cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), [&] {
    return capability_results_.contains(id);
  }) && capability_results_[id];
}

bool ToolApprovalGate::require_tool_approval(const std::string& tool, const nlohmann::json& args,
                                             const nlohmann::json& config) {
  last_tool_approval_error_.clear();
  const std::string mode = config.value("approvalMode", "smart");
  const bool trusted = config_has_trusted_tool(config, tool);
  const bool danger = is_dangerous_tool(tool, args);
  const bool sensitive = sensitive_tools().count(tool) > 0;

  if (autonomous_tools().count(tool) && !danger) return true;
  if (danger && !config.value("allowShell", false) && !config.value("autoApproveTools", false)) {
    return false;
  }
  if (config.value("autoApproveTools", false) && !danger) return true;

  if (mode == "off") {
    if (!danger) return true;
  } else if (mode == "smart") {
    if (trusted) return true;
    if (!sensitive && !danger) return true;
    if (tool == "run_python" && args.contains("path") && args["path"].is_string()) {
      const std::string path = args["path"].get<std::string>();
      if (path.starts_with("code/") || path.starts_with("code\\")) return true;
    }
  } else if (mode == "always") {
    if (trusted && !danger) return true;
  }

  const std::string id = random_uuid();
  const int64_t created_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count();
  nlohmann::json payload;
  {
    std::lock_guard lock(mu_);
    pending_tools_[id] = PendingApproval{
        id, tool, args, "general",
        danger ? std::optional<std::string>("Detected potentially destructive command pattern.")
               : sensitive ? std::optional<std::string>(
                                 "Sensitive tool: may modify files, run shell, or contact the network.")
                           : std::nullopt,
        created_at};
    const auto& p = pending_tools_[id];
    payload = {{"id", id},
               {"tool", p.tool},
               {"args", p.args},
               {"kind", p.kind},
               {"rationale", p.rationale.value_or("")},
               {"createdAt", created_at}};
  }
  if (event_sink_) event_sink_("omega:tool:approve:req", payload);
  if (!wait_for_tool(id, 120'000)) {
    std::lock_guard lock(mu_);
    const bool denied = tool_results_.contains(id) && !tool_results_.at(id);
    last_tool_approval_error_ =
        denied ? "Tool approval denied."
               : "Tool approval timed out — approve or deny in the chat prompt (or modal) within "
                 "2 minutes.";
    if (event_sink_) event_sink_("omega:tool:approve:expired", {{"id", id}});
    pending_tools_.erase(id);
    tool_results_.erase(id);
    return false;
  }
  std::lock_guard lock(mu_);
  pending_tools_.erase(id);
  tool_results_.erase(id);
  return true;
}

bool ToolApprovalGate::resolve_tool(const std::string& id, bool approved) {
  std::lock_guard lock(mu_);
  if (pending_tools_.contains(id)) {
    tool_results_[id] = approved;
    cv_.notify_all();
    return true;
  }
  if (tool_results_.contains(id)) return true;
  return false;
}

nlohmann::json ToolApprovalGate::list_pending_tools() const {
  std::lock_guard lock(mu_);
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& [id, p] : pending_tools_) {
    arr.push_back({{"id", id},
                   {"tool", p.tool},
                   {"args", p.args},
                   {"kind", p.kind},
                   {"rationale", p.rationale.value_or("")},
                   {"createdAt", p.created_at_ms}});
  }
  return arr;
}

bool ToolApprovalGate::require_capability(
    const std::string& capability, const std::string& tool, const nlohmann::json& args,
    const nlohmann::json& config,
    const std::function<nlohmann::json(const nlohmann::json&)>& save_config) {
  last_capability_error_.clear();
  if (is_capability_enabled(capability, config)) return true;
  if (config.value("autoApproveCapabilities", false)) {
    nlohmann::json patch;
    if (capability == "web_fetch") patch["allowWebFetch"] = true;
    else if (capability == "browser") patch["allowBrowser"] = true;
    else if (capability == "shell") patch["allowShell"] = true;
    else if (capability == "host_filesystem") patch["allowHostFilesystem"] = true;
    else if (capability == "finetune") patch["allowFinetune"] = true;
    else if (capability == "content_studio") patch["allowContentStudio"] = true;
    save_config(patch);
    return true;
  }

  const std::string id = random_uuid();
  nlohmann::json payload;
  {
    std::lock_guard lock(mu_);
    payload = capability_permission_payload(id, capability, tool, args);
    pending_capabilities_[id] = payload;
  }
  if (event_sink_) event_sink_("omega:capability:permission:req", payload);
  if (!wait_for_capability(id, 120'000)) {
    std::lock_guard lock(mu_);
    const bool denied = capability_results_.contains(id) && !capability_results_.at(id);
    last_capability_error_ =
        denied ? "Permission denied."
               : "Permission prompt timed out — respond in chat within 2 minutes.";
    pending_capabilities_.erase(id);
    capability_results_.erase(id);
    return false;
  }

  nlohmann::json patch;
  if (capability == "web_fetch") patch["allowWebFetch"] = true;
  else if (capability == "browser") patch["allowBrowser"] = true;
  else if (capability == "shell") patch["allowShell"] = true;
  else if (capability == "host_filesystem") patch["allowHostFilesystem"] = true;
  else if (capability == "finetune") patch["allowFinetune"] = true;
  else if (capability == "content_studio") patch["allowContentStudio"] = true;
  save_config(patch);

  std::lock_guard lock(mu_);
  pending_capabilities_.erase(id);
  capability_results_.erase(id);
  return true;
}

bool ToolApprovalGate::resolve_capability(
    const std::string& id, bool approved, bool remember,
    const std::function<nlohmann::json(const nlohmann::json&)>& save_config) {
  if (remember) save_config({{"autoApproveCapabilities", true}});
  std::lock_guard lock(mu_);
  if (!pending_capabilities_.contains(id)) return false;
  capability_results_[id] = approved;
  cv_.notify_all();
  return true;
}

nlohmann::json ToolApprovalGate::list_pending_capabilities() const {
  std::lock_guard lock(mu_);
  nlohmann::json arr = nlohmann::json::array();
  for (const auto& [id, payload] : pending_capabilities_) arr.push_back(payload);
  return arr;
}

}  // namespace omega::runtime
