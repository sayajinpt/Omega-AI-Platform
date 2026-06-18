#include "omega/runtime/native_routes.hpp"

#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/storage/cron_store.hpp"
#include "omega/runtime/storage/kanban_store.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/input_pipeline_store.hpp"
#include "omega/runtime/storage/mcp_store.hpp"
#include "omega/runtime/storage/plugin_store.hpp"
#include "omega/runtime/storage/profile_store.hpp"
#include "omega/runtime/storage/provider_store.hpp"
#include "omega/runtime/storage/rag_store.hpp"
#include "omega/runtime/session_cleanup.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/storage/skills_store.hpp"
#include "omega/runtime/storage/soul_store.hpp"
#include "omega/runtime/storage/workflow_store.hpp"
#include "omega/runtime/chat/agent_service.hpp"
#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/chat/message_media.hpp"
#include "omega/runtime/chat/stream_hub.hpp"
#include "omega/runtime/orchestrator/prompts.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/json_safe.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/inference/model_load_payload.hpp"
#include "omega/runtime/media/content_studio_native_media.hpp"
#include "omega/runtime/services/content_studio_native_status.hpp"
#include "omega/runtime/media/studio_media_runner.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/services/mcp_client_manager.hpp"
#include "omega/runtime/services/gateway_manager.hpp"
#include "omega/runtime/services/pipeline_activity.hpp"
#include "omega/runtime/services/debug_store.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/storage/model_config_store.hpp"
#include "omega/runtime/finetune/finetune_runner.hpp"
#include "omega/runtime/finetune/finetune_capabilities.hpp"
#include "omega/runtime/finetune/finetune_dataset_service.hpp"
#include "omega/runtime/models/model_meta_service.hpp"
#include "omega/runtime/models/hf_client.hpp"
#include "omega/runtime/models/gpu_probe.hpp"
#include "omega/runtime/models/model_presets.hpp"
#include "omega/runtime/services/terminal_store.hpp"
#include "omega/runtime/services/editor_service.hpp"
#include "omega/runtime/storage/integrations_store.hpp"
#include "omega/runtime/storage/usage_store.hpp"
#include "omega/runtime/services/self_improve_service.hpp"
#include "omega/runtime/services/chat_attachment_service.hpp"
#include "omega/runtime/services/office_visualization_service.hpp"
#include "omega/runtime/services/workforce_store.hpp"
#include "omega/runtime/services/workforce_orchestrator.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/services/updater_service.hpp"
#include "omega/runtime/models/model_download_service.hpp"
#include "omega/runtime/models/model_quantize_service.hpp"
#include "omega/runtime/models/model_load_progress.hpp"
#include "omega/runtime/services/sidecar_service.hpp"
#include "omega/runtime/services/router_models_service.hpp"
#include "omega/runtime/services/desktop_aux_service.hpp"
#include "omega/runtime/services/content_job_delivery_service.hpp"
#include "omega/runtime/services/assistant_prompt.hpp"
#include "omega/runtime/services/integrations_api.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/finetune_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/services/mcp_omega_handler.hpp"
#include "omega/runtime/util/context_trim.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/workflows/workflow_runner.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <thread>
#include <vector>

namespace omega::runtime {

namespace {

using json = nlohmann::json;

json parse_body(const httplib::Request& req) {
  if (req.body.empty()) return json::object();
  return json::parse(req.body);
}

json args_from_body(const httplib::Request& req) {
  if (req.body.empty()) return json::array();
  const json parsed = json::parse(req.body);
  return parsed.is_array() ? parsed : json::array({parsed});
}

std::string arg_string(const json& args, size_t i, const std::string& fallback = "") {
  if (!args.is_array() || args.size() <= i) return fallback;
  if (args[i].is_string()) return args[i].get<std::string>();
  return fallback;
}

int json_to_int(const json& v, int fallback = 0) {
  if (v.is_number_integer()) return static_cast<int>(v.get<int64_t>());
  if (v.is_number_unsigned()) return static_cast<int>(v.get<uint64_t>());
  if (v.is_number_float()) return static_cast<int>(v.get<double>());
  return fallback;
}

int arg_int(const json& args, size_t i, int fallback = 0) {
  if (!args.is_array() || args.size() <= i) return fallback;
  return json_to_int(args[i], fallback);
}

std::string body_string(const httplib::Request& req, const std::string& key,
                        const std::string& alt_key = "") {
  const json body = parse_body(req);
  if (!body.is_object()) return "";
  if (body.contains(key) && body[key].is_string()) return body[key].get<std::string>();
  if (!alt_key.empty() && body.contains(alt_key) && body[alt_key].is_string()) {
    return body[alt_key].get<std::string>();
  }
  return "";
}

int body_int(const httplib::Request& req, const std::string& key, int fallback = 0) {
  const json body = parse_body(req);
  if (!body.is_object() || !body.contains(key)) return fallback;
  return json_to_int(body[key], fallback);
}

/** IPC array args first; object body fields only when args are missing (never .value on arrays). */
std::string arg_string_or_body(const httplib::Request& req, const json& args, size_t i,
                               const std::string& body_key,
                               const std::string& alt_body_key = "") {
  const std::string from_args = arg_string(args, i, "");
  if (!from_args.empty()) return from_args;
  return body_string(req, body_key, alt_body_key);
}

int arg_int_or_body(const httplib::Request& req, const json& args, size_t i,
                    const std::string& body_key, int fallback = 0) {
  if (args.is_array() && args.size() > i) {
    const int from_args = json_to_int(args[i], fallback);
    if (args[i].is_number()) return from_args;
  }
  return body_int(req, body_key, fallback);
}

std::string id_from_ipc_body(const httplib::Request& req) {
  const json args = args_from_body(req);
  std::string id = arg_string(args, 0, "");
  if (!id.empty()) return id;
  if (req.body.empty()) return id;
  const json body = json::parse(req.body);
  if (body.is_object()) return body.value("id", body.value("jobId", ""));
  return id;
}

/** Query ?id= first (HTTP DELETE from ipc-http-map), then JSON body / IPC array args. */
std::string id_from_ipc_request(const httplib::Request& req) {
  static const char* k_query_keys[] = {"id", "jobId", "streamId", "role", "modelId"};
  for (const char* key : k_query_keys) {
    const std::string v = req.get_param_value(key);
    if (!v.empty()) return v;
  }
  return id_from_ipc_body(req);
}

template <typename Handler>
void register_post_and_delete(httplib::Server& svr, const char* path, Handler handler) {
  svr.Post(path, handler);
  svr.Delete(path, handler);
}

std::optional<std::string> find_cs_project_for_job(const std::string& job_id) {
  const std::filesystem::path storage = resolve_content_studio_storage();
  std::error_code ec;
  if (!std::filesystem::exists(storage, ec)) return std::nullopt;
  for (const auto& ent : std::filesystem::directory_iterator(storage, ec)) {
    if (ec || !ent.is_directory()) continue;
    const std::filesystem::path mp4 = ent.path() / job_id / "final.mp4";
    if (std::filesystem::exists(mp4, ec) && std::filesystem::is_regular_file(mp4, ec) &&
        std::filesystem::file_size(mp4, ec) >= 512) {
      return ent.path().filename().string();
    }
  }
  return std::nullopt;
}

void apply_cs_disk_success(json& st, const std::string& project_id, const std::string& job_id) {
  if (project_id.empty()) return;
  const std::filesystem::path mp4 =
      std::filesystem::path(resolve_content_studio_storage()) / project_id / job_id / "final.mp4";
  std::error_code ec;
  if (!std::filesystem::exists(mp4, ec) || !std::filesystem::is_regular_file(mp4, ec) ||
      std::filesystem::file_size(mp4, ec) < 512) {
    return;
  }
  const std::string rel = project_id + "/" + job_id + "/final.mp4";
  st["video_ready"] = true;
  st["worker_running"] = false;
  st["mp4_path"] = rel;
  const std::string raw = st.value("status", "");
  if (raw == "running" || raw == "queued" || raw.empty()) st["status"] = "succeeded";
}

std::string model_id_from_req(const httplib::Request& req) {
  if (req.has_param("modelId")) return req.get_param_value("modelId");
  const json args = args_from_body(req);
  std::string id = arg_string(args, 0, "");
  if (!id.empty()) return id;
  if (req.body.empty()) return id;
  try {
    const json body = json::parse(req.body);
    if (body.is_object()) return body.value("modelId", "");
  } catch (...) {
  }
  return id;
}

json body_object(const httplib::Request& req) {
  if (req.body.empty()) return json::object();
  const json parsed = json::parse(req.body);
  if (parsed.is_array() && !parsed.empty() && parsed[0].is_object()) return parsed[0];
  return parsed.is_object() ? parsed : json::object();
}

void json_ok(httplib::Response& res, const json& data) {
  res.set_content(json_dump_safe(data), "application/json");
}

void json_err(httplib::Response& res, int code, const std::string& msg) {
  res.status = code;
  res.set_content(json_dump_safe(json{{"error", msg}}), "application/json");
}

namespace fs = std::filesystem;

bool media_ref_safe(const std::string& ref) { return is_session_media_ref_safe(ref); }

std::string session_media_mime(const std::string& path) {
  std::string ext = fs::path(path).extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (ext == ".mp4") return "video/mp4";
  if (ext == ".webm") return "video/webm";
  if (ext == ".mov") return "video/quicktime";
  if (ext == ".mp3") return "audio/mpeg";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".ogg") return "audio/ogg";
  if (ext == ".m4a") return "audio/mp4";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".gif") return "image/gif";
  if (ext == ".webp") return "image/webp";
  return "application/octet-stream";
}

void serve_binary_file(httplib::Response& res, const std::string& path) {
  if (path.empty() || !fs::exists(path)) {
    json_err(res, 404, "not found");
    return;
  }
  const auto size = static_cast<size_t>(fs::file_size(path));
  const std::string mime = session_media_mime(path);
  auto file = std::make_shared<std::ifstream>(path, std::ios::binary);
  if (!file->is_open()) {
    json_err(res, 500, "read failed");
    return;
  }
  res.set_header("Cache-Control", "private, max-age=3600");
  res.set_header("Accept-Ranges", "bytes");
  res.set_content_provider(
      size, mime,
      [file](size_t offset, size_t length, httplib::DataSink& sink) {
        if (!file->seekg(static_cast<std::streamoff>(offset))) return false;
        std::vector<char> buf(length);
        file->read(buf.data(), static_cast<std::streamsize>(length));
        const auto got = static_cast<size_t>(file->gcount());
        if (got == 0) return false;
        return sink.write(buf.data(), got);
      },
      [file](bool) {});
}

void emit_cron_changed(EventBus& events) {
  events.publish("omega:cron:changed", json::object());
}

void emit_kanban_changed(EventBus& events) {
  events.publish("omega:kanban:changed", json::object());
}

void register_event_channel_route(httplib::Server& svr, const char* path, const char* channel) {
  svr.Get(path, [channel](const httplib::Request&, httplib::Response& res) {
    json_ok(res, json{{"channel", channel},
                      {"transport", "event_bus"},
                      {"poll", "/v1/events/poll"},
                      {"sse", "/v1/events/sse"}});
  });
}

}  // namespace

bool is_native_http_route(const std::string& method, const std::string& path) {
  static const char* k_native[] = {
      "/healthz",              "/v1/config",           "/v1/runtime/info",
      "/v1/runtime/routes",   "/v1/runtime/status",
      "/v1/system/info",
      "/v1/models",            "/v1/models/loaded",    "/v1/models/load",
      "/v1/models/load-progress", "/v1/models/unload", "/v1/models/download",
      "/v1/models/download-required", "/v1/models/download/cancel",
      "/v1/models/download-adapter", "/v1/models/quantize",
      "/v1/models/inventoryChanged",
      "/v1/embed",             "/v1/ipc/invoke",       "/v1/sessions/list",
      "/v1/sessions/create",   "/v1/sessions/delete",  "/v1/sessions/messages",
      "/v1/sessions/updateTitle", "/v1/sessions/updateModel", "/v1/sessions/fork", "/v1/sessions/truncate",
      "/v1/sessions/search",   "/v1/sessions/media", "/v1/memory/list",      "/v1/memory/add",
      "/v1/memory/delete",     "/v1/memory/search",    "/v1/memory/graph",
      "/v1/memory/export",     "/v1/memory/import",    "/v1/memory/janitorRun",
      "/v1/rag/list",          "/v1/rag/index-file",   "/v1/rag/index-dir",
      "/v1/rag/clear",         "/v1/rag/search",       "/v1/workflows/list",
      "/v1/workflows/get",     "/v1/workflows/save",   "/v1/workflows/delete",
      "/v1/workflows/run",     "/v1/workflows/abort",
      "/v1/skills/list",       "/v1/skills/get",       "/v1/skills/save",
      "/v1/skills/delete",     "/v1/skills/toggle",    "/v1/profiles/list",
      "/v1/profiles/create",   "/v1/profiles/switch",  "/v1/profiles/delete",
      "/v1/soul/get",          "/v1/soul/set",         "/v1/soul/reset",
      "/v1/orchestrator-prompts/defaults",
      "/v1/cron/list",         "/v1/cron/save",        "/v1/cron/delete",
      "/v1/cron/pause",        "/v1/cron/runNow",      "/v1/kanban/list",
      "/v1/kanban/save",       "/v1/kanban/move",      "/v1/kanban/delete",
      "/v1/kanban/dispatch",    "/v1/tools/list",
      "/v1/tools/toggle",      "/v1/tools/run",        "/v1/tool/approve/resolve",
      "/v1/tool/approve/pending",       "/v1/capability/permission/resolve",
      "/v1/capability/permission/pending", "/v1/chat/send", "/v1/chat/abort",
      "/v1/chat/stream/poll", "/v1/agent/run", "/v1/agent/abort", "/v1/events/poll",
      "/v1/events/sse", "/v1/providers/list", "/v1/providers/save", "/v1/providers/delete",
      "/v1/providers/fetchModels", "/v1/providers/presets", "/v1/providers/discover",
      "/v1/input-pipelines/list", "/v1/input-pipelines/get",
      "/v1/input-pipelines/save", "/v1/input-pipelines/delete", "/v1/input-pipelines/set-active",
      "/v1/context/buffer", "/v1/plugins/list", "/v1/plugins/catalog", "/v1/plugins/toggle",
      "/v1/plugins/reload", "/v1/plugins/installBuiltin", "/v1/plugins/installUrl",
      "/v1/plugins/uninstall", "/v1/mcp/list", "/v1/mcp/save", "/v1/mcp/delete", "/v1/mcp/status",
      "/v1/mcp/start", "/v1/mcp/stop",
      "/v1/engines/ollama/start", "/v1/engines/ollama/stop", "/v1/engines/ollama/list",
      "/v1/engines/ollama/pull", "/v1/mcp",
      "/v1/gateway/platforms", "/v1/gateway/list", "/v1/gateway/save", "/v1/gateway/delete",
      "/v1/gateway/start", "/v1/gateway/stop", "/v1/gateway/status",
      "/v1/engines/status", "/v1/inference/backends", "/v1/inference/backend",
      "/v1/inference/switch", "/v1/inference/media/capabilities", "/v1/inference/media/image",
      "/v1/inference/media/tts", "/v1/python/status",
      "/v1/python/setup",
      "/v1/engines/sidecar/status", "/v1/engines/sidecar/install",
      "/v1/engines/sidecar/uninstall",
      "/v1/events/config/changed", "/v1/events/cron/changed", "/v1/events/kanban/changed",
      "/v1/events/providers/changed", "/v1/events/download/progress",
      "/v1/events/quantize/progress", "/v1/events/models/load-progress",
      "/v1/events/models/inventoryChanged", "/v1/events/tool/approve/req",
      "/v1/events/capability/permission/req", "/v1/events/stream/token",
      "/v1/events/stream/metrics", "/v1/events/stream/media", "/v1/events/stream/done",
      "/v1/events/stream/error", "/v1/events/pipeline/activity/changed",
      "/v1/events/runtime/status-changed", "/v1/events/engines/ollama/pullProgress",
      "/v1/events/engines/sidecar/installProgress", "/v1/events/finetune/progress",
      "/v1/events/content-studio/changed", "/v1/events/content-studio/setupProgress",
      "/v1/events/content-studio/webhook",
      "/v1/events/session/messageAppended", "/v1/events/session/assistantPatch",
      "/v1/events/agent/step", "/v1/events/agent/token", "/v1/events/debug/event",
      "/v1/events/workflows/event", "/v1/events/routerModels/buildProgress",
      "/v1/events/browser/hidden", "/v1/events/companion/send-deliver",
      "/v1/events/companion/reply-deliver", "/v1/events/avatar-monitor/enabled",
      "/v1/events/avatar-monitor/layout", "/v1/events/avatar-monitor/signals",
      "/v1/events/screen-snip/init", "/v1/events/voice/speak",
      "/v1/routerModels/status", "/v1/routerModels/installNodeRuntime",
      "/v1/routerModels/setupPython", "/v1/routerModels/build", "/v1/routerModels/remove",
      "/v1/browser/show", "/v1/browser/hide", "/v1/browser/hidden", "/v1/browser/mediaCommand",
      "/v1/browser/setBounds", "/v1/browser/navigate", "/v1/browser/back", "/v1/browser/forward",
      "/v1/browser/reload", "/v1/browser/status", "/v1/browser/getStatus", "/v1/browser/info",
      "/v1/companion/set-active-chat", "/v1/companion/get-active-chat",
      "/v1/companion/send-to-main", "/v1/companion/send-deliver",
      "/v1/companion/reply-broadcast", "/v1/companion/reply-deliver",
      "/v1/avatar-monitor/set-enabled", "/v1/avatar-monitor/get-enabled",
      "/v1/avatar-monitor/enabled", "/v1/avatar-monitor/signals",
      "/v1/avatar-monitor/sync-layout", "/v1/avatar-monitor/layout",
      "/v1/avatar-monitor/set-overlay-visible", "/v1/avatar-monitor/restore-main",
      "/v1/screen-snip/capture", "/v1/screen-snip/get-bounds", "/v1/screen-snip/submit",
      "/v1/screen-snip/cancel", "/v1/screen-snip/save", "/v1/screen-snip/init",
      "/v1/voice/speak",
      "/v1/session/messageAppended", "/v1/session/assistantPatch",
      "/v1/content-studio/youtubeConnect", "/v1/content-studio/generationDownload",
      "/v1/media/reopenSessionVideo",
      "/v1/engine/command",   "/v1/generate",
      "/v1/project/open", "/v1/project/list", "/v1/pipeline/activity",
      "/v1/debug/history", "/v1/content-studio/status", "/v1/content-studio/webhook",
      "/v1/content-studio/start",
      "/v1/content-studio/stop", "/v1/content-studio/restart", "/v1/content-studio/projects",
      "/v1/content-studio/createRun", "/v1/content-studio/runStatus",
      "/v1/content-studio/forceStopJob", "/v1/content-studio/schedules",
      "/v1/content-studio/scheduleCreate", "/v1/content-studio/scheduleDelete",
      "/v1/content-studio/socialPlatforms", "/v1/content-studio/socialAccounts",
      "/v1/content-studio/socialPosts", "/v1/content-studio/socialPublish",
      "/v1/content-studio/credentialsGet", "/v1/content-studio/credentialsSet",
      "/v1/content-studio/credentialsSync", "/v1/content-studio/credentialsStatus",
      "/v1/content-studio/native/render", "/v1/content-studio/jobMedia",
      "/v1/content-studio/seriesList", "/v1/content-studio/seriesCreate",
      "/v1/content-studio/seriesDelete", "/v1/content-studio/generationGet",
      "/v1/content-studio/generationSet", "/v1/content-studio/generationCatalog",
      "/v1/content-studio/generationCapabilities",
      "/v1/finetune/list", "/v1/finetune/get", "/v1/finetune/create", "/v1/finetune/delete",
      "/v1/finetune/start", "/v1/finetune/abort", "/v1/finetune/analyze",
      "/v1/finetune/prepareDataset", "/v1/finetune/listDatasets", "/v1/finetune/listPresets",
      "/v1/finetune/savePreset", "/v1/finetune/deletePreset", "/v1/finetune/inspectSource",
      "/v1/finetune/pickSources", "/v1/finetune/datasetsRoot", "/v1/finetune/deletePrepared",
      "/v1/model-config/list", "/v1/model-config/get", "/v1/model-config/set",
      "/v1/model-config/reset", "/v1/model-presets/list", "/v1/model-presets/apply",
      "/v1/model/inspect", "/v1/model/estimate", "/v1/model/estimateFile",
      "/v1/models/footprint", "/v1/models/benchmark", "/v1/models/check-hf-access",
      "/v1/models/repo-files", "/v1/models/open-hf-repo", "/v1/hf/search", "/v1/hf/card",
      "/v1/hf/tags", "/v1/gpu/list", "/v1/memory/projectContext",
      "/v1/chat/attachment-limits", "/v1/chat/pick-attachments", "/v1/chat/stage-attachment",
      "/v1/terminal/history", "/v1/terminal/clear", "/v1/terminal/runSnippet",
      "/v1/terminal/saveSnippet", "/v1/terminal/line", "/v1/editor/read", "/v1/editor/write",
      "/v1/editor/openFiles", "/v1/editor/saveAs", "/v1/editor/deleteFile", "/v1/context/find",
      "/v1/context/gotoLine", "/v1/usage/summary", "/v1/integrations/get", "/v1/integrations/set",
      "/v1/assistant/defaultPrompt", "/v1/self-improve/list", "/v1/self-improve/reflect",
      "/v1/self-improve/janitor", "/v1/workforce/agents", "/v1/workforce/runs",
      "/v1/workforce/delegate", "/v1/workforce/moa", "/v1/workforce/standup", "/v1/workforce/parallel",
      "/v1/office/snapshot", "/v1/office/changed", "/v1/office/addMonitor", "/v1/office/refreshMonitor",
      "/v1/office/fetchPr", "/v1/office/prComment", "/v1/office/prReview", "/v1/office/jiraComment",
      "/v1/office/pollSet", "/v1/office/pollRefreshAll", "/v1/office/skillGym", "/v1/office/janitor",
      "/v1/office/kanbanPin", "/v1/office/kanbanMonitor", "/v1/office/visualization/status",
      "/v1/office/visualization/setup", "/v1/office/visualization/start", "/v1/office/visualization/stop",
      "/v1/media/state", "/v1/media/stop", "/v1/media/pause", "/v1/media/resume", "/v1/media/showPreview",
      "/v1/updater/status", "/v1/updater/check", "/v1/updater/install", "/v1/updater/status-event"};
  for (const char* p : k_native) {
    if (path == p) return true;
  }
  if (method == "POST" && path.rfind("/v1/gateway/", 0) == 0) {
    const std::string tail = path.substr(14);
    if (tail != "save" && tail != "delete" && tail != "start" && tail != "stop" && tail != "list" &&
        tail != "status" && tail != "platforms") {
      return true;
    }
  }
  if (method == "DELETE" && path.rfind("/v1/models/", 0) == 0) return true;
  return false;
}

void register_native_routes(httplib::Server& svr, const NativeRouteDeps& deps) {
  ConfigStore& config = deps.config;
  SessionStore& sessions = deps.sessions;
  MemoryStore& memory = deps.memory;
  RagStore& rag = deps.rag;
  WorkflowStore& workflows = deps.workflows;
  ProfileContext& profile_ctx = deps.profile;
  ProfileStore& profiles = deps.profiles;
  ProviderStore& providers = deps.providers;
  InputPipelineStore& input_pipelines = deps.input_pipelines;
  PluginStore& plugins = deps.plugins;
  McpStore& mcp = deps.mcp;
  McpClientManager& mcp_clients = deps.mcp_clients;
  GatewayManager& gateway = deps.gateway;
  ProjectStore& projects = deps.projects;
  PipelineActivityService& pipeline_activity = deps.pipeline_activity;
  DebugStore& debug_store = deps.debug_store;
  FinetuneStore& finetune = deps.finetune;
  FinetuneRunner& finetune_runner = deps.finetune_runner;
  FinetuneDatasetService& finetune_datasets = deps.finetune_datasets;
  ModelMetaService& model_meta = deps.model_meta;
  HfClient& hf_client = deps.hf_client;
  TerminalStore& terminal_store = deps.terminal_store;
  IntegrationsStore& integrations = deps.integrations;
  UsageStore& usage = deps.usage;
  SelfImproveService& self_improve = deps.self_improve;
  ChatAttachmentService& chat_attachments = deps.chat_attachments;
  WorkforceStore& workforce_store = deps.workforce_store;
  WorkforceOrchestrator& workforce = deps.workforce;
  GitHubClient& github = deps.github;
  JiraClient& jira = deps.jira;
  MediaPlayerService& media_player = deps.media_player;
  UpdaterService& updater = deps.updater;
  OfficeVisualizationService& office_viz = deps.office_viz;
  ModelDownloadService& model_download = deps.model_download;
  ModelQuantizeService& model_quantize = deps.model_quantize;
  ModelLoadProgress& model_load_progress = deps.model_load_progress;
  SidecarService& sidecar = deps.sidecar;
  RouterModelsService& router_models = deps.router_models;
  DesktopAuxService& desktop_aux = deps.desktop_aux;
  ContentJobDeliveryService& content_job_delivery = deps.content_job_delivery;
  ContentStudioSupervisor& content_studio = deps.content_studio;
  ContentStudioOrchestrator& content_orchestrator = deps.content_orchestrator;
  ContentStudioSettings& cs_settings = deps.content_studio_settings;
  ModelConfigStore& model_config = deps.model_config;
  EngineClient& engine = deps.engine;
  SkillsStore& skills = deps.skills;
  SoulStore& soul = deps.soul;
  CronStore& cron = deps.cron;
  KanbanStore& kanban = deps.kanban;
  ToolRegistry& tools = deps.tools;
  ChatService& chat = deps.chat;
  AgentService& agent = deps.agent;
  EventBus& events = deps.events;
  WorkflowRunner& workflow_runner = deps.workflow_runner;
  svr.Get("/v1/sessions/list", [&sessions](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, sessions.list_sessions());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/create", [&sessions, &debug_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      std::string title = "New chat";
      std::string model_id;
      std::string system_prompt;
      if (args.is_array() && !args.empty() && args[0].is_object()) {
        const json& body = args[0];
        title = body.value("title", "New chat");
        model_id = body.value("modelId", body.value("model_id", ""));
        system_prompt = body.value("systemPrompt", body.value("system_prompt", ""));
      } else if (args.is_array()) {
        title = arg_string(args, 0, "New chat");
        model_id = arg_string(args, 1, "");
        system_prompt = arg_string(args, 2, "");
      } else {
        const json body = body_object(req);
        title = body.value("title", "New chat");
        model_id = body.value("modelId", body.value("model_id", ""));
        system_prompt = body.value("systemPrompt", body.value("system_prompt", ""));
      }
      const json created = sessions.create_session(title, model_id, system_prompt);
      debug_store.log("sessions", "created " + created.value("id", ""), "info");
      json_ok(res, created);
    } catch (const std::exception& e) {
      debug_store.log("sessions", e.what(), "error");
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/delete", [&sessions, &projects, &content_job_delivery, &content_orchestrator,
                                  &content_studio, &usage, &media_player](
                                     const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("session id required");
      const SessionCleanupDeps cleanup{
          sessions,      &projects,           &content_job_delivery, &content_orchestrator,
          &content_studio, &usage,            &media_player};
      json_ok(res, delete_session_with_cleanup(id, cleanup));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get(R"(/v1/sessions/messages)", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string session_id = req.get_param_value("sessionId");
      if (session_id.empty()) session_id = req.get_param_value("session_id");
      if (session_id.empty()) {
        const json args = args_from_body(req);
        session_id = arg_string(args, 0, "");
      }
      if (session_id.empty()) throw std::runtime_error("sessionId required");
      json_ok(res, sessions.get_messages(session_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/messages", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string session_id = arg_string_or_body(req, args, 0, "sessionId");
      if (session_id.empty()) throw std::runtime_error("sessionId required");
      json_ok(res, sessions.get_messages(session_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/sessions/media", [&projects](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string session_id = req.get_param_value("sessionId");
      if (session_id.empty()) session_id = req.get_param_value("session_id");
      const std::string ref = req.get_param_value("ref");
      if (session_id.empty() || ref.empty()) {
        json_err(res, 400, "sessionId and ref required");
        return;
      }
      if (!media_ref_safe(ref)) {
        json_err(res, 400, "invalid ref");
        return;
      }
      const std::string path = resolve_session_media_path(session_id, ref, projects);
      serve_binary_file(res, path);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/updateTitle", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, "");
      const std::string title = arg_string(args, 1, "");
      if (id.empty() || title.empty()) throw std::runtime_error("id and title required");
      sessions.update_title(id, title);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/updateModel", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id", "sessionId");
      const std::string model_id = arg_string_or_body(req, args, 1, "modelId", "model_id");
      if (id.empty() || model_id.empty()) throw std::runtime_error("id and modelId required");
      sessions.update_model_id(id, model_id);
      json_ok(res, json{{"ok", true}, {"modelId", model_id}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/fork", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("session id required");
      json_ok(res, sessions.fork_session(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/truncate", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, "");
      const int from_index = arg_int_or_body(req, args, 1, "fromIndex", 0);
      if (id.empty()) throw std::runtime_error("session id required");
      sessions.truncate_messages(id, from_index);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/sessions/search", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string query = req.get_param_value("q").empty() ? req.get_param_value("query")
                                                                 : req.get_param_value("q");
      json_ok(res, sessions.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/sessions/search", [&sessions](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string query = arg_string_or_body(req, args, 0, "query");
      json_ok(res, sessions.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/memory/list", [&memory](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, memory.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/memory/add", [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string kind = arg_string(args, 0, "fact");
      const std::string content = arg_string(args, 1, "");
      const std::string session_id = arg_string(args, 2, "");
      if (content.empty()) throw std::runtime_error("content required");
      const json entry = memory.add(kind, content, session_id);
      json_ok(res, entry);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_memory = [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      memory.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/memory/delete", delete_memory);

  svr.Get("/v1/memory/search", [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string query = req.get_param_value("q").empty() ? req.get_param_value("query")
                                                                 : req.get_param_value("q");
      json_ok(res, memory.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/memory/search", [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string query = arg_string(args, 0, "");
      json_ok(res, memory.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/memory/graph", [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string run_id = req.get_param_value("runId");
      json_ok(res, memory.list_decisions(run_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/memory/export", [&memory](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, memory.export_bundle());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/memory/import", [&memory](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json bundle = args.size() > 0 ? args[0] : parse_body(req);
      const std::string mode = arg_string(args, 1, "merge");
      json_ok(res, memory.import_bundle(bundle, mode));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/memory/janitorRun", [&memory](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, memory.run_janitor());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/rag/list", [&rag](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, rag.list_sources());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/rag/index-file", [&rag](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string path = arg_string_or_body(req, args, 0, "path");
      if (path.empty()) throw std::runtime_error("path required");
      json_ok(res, rag.index_file(path));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/rag/index-dir", [&rag](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string path = arg_string_or_body(req, args, 0, "path");
      if (path.empty()) throw std::runtime_error("path required");
      json_ok(res, rag.index_directory(path));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto clear_rag = [&rag](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string source = req.get_param_value("source");
      if (source.empty()) {
        const json args = args_from_body(req);
        source = arg_string(args, 0, body_object(req).value("source", ""));
      }
      rag.clear_index(source);
      json_ok(res, json{{"cleared", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/rag/clear", clear_rag);

  svr.Get("/v1/rag/search", [&rag](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string query = req.get_param_value("q").empty() ? req.get_param_value("query")
                                                                 : req.get_param_value("q");
      json_ok(res, rag.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/rag/search", [&rag](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string query = arg_string_or_body(req, args, 0, "query");
      json_ok(res, rag.search(query));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/workflows/list", [&workflows](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, workflows.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/workflows/get", [&workflows](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string id = req.get_param_value("id");
      if (id.empty()) id = arg_string(args_from_body(req), 0, "");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, workflows.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/workflows/get", [&workflows](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, workflows.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/workflows/save", [&workflows](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json wf = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, workflows.save(wf));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_workflow = [&workflows](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      workflows.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/workflows/delete", delete_workflow);

  svr.Post("/v1/workflows/run", [&](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = parse_body(req);
      const std::string id = arg_string(args, 0, body.value("id", body.value("workflowId", "")));
      if (id.empty()) throw std::runtime_error("workflow id required");
      json vars = json::object();
      if (args.size() > 1 && args[1].is_object()) vars = args[1];
      else if (body.contains("vars")) vars = body["vars"];
      std::string model = arg_string(args, 2, "");
      if (model.empty()) model = body.value("model", "");
      if (model.empty()) model = config.load().value("defaultModel", "");
      const json wf = workflows.get(id);
      json_ok(res, workflow_runner.run(wf, vars, model));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto abort_workflow = [&workflow_runner](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = parse_body(req);
      std::string run_id = id_from_ipc_request(req);
      if (run_id.empty()) run_id = arg_string(args, 0, body.value("runId", body.value("run_id", "")));
      json_ok(res, workflow_runner.abort(run_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/workflows/abort", abort_workflow);

  svr.Get("/v1/skills/list", [&skills](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, skills.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/skills/get", [&skills](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string id = req.get_param_value("id");
      if (id.empty()) id = arg_string(args_from_body(req), 0, "");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, skills.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/skills/get", [&skills](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, skills.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/skills/save", [&skills](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, skills.save(input));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_skill = [&skills](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      skills.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/skills/delete", delete_skill);

  svr.Post("/v1/skills/toggle", [&skills](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const bool enabled = body.contains("enabled") ? body.value("enabled", true)
                                                    : (args.size() > 1 && args[1].is_boolean()
                                                           ? args[1].get<bool>()
                                                           : true);
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, skills.toggle(id, enabled));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/profiles/list", [&profiles](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, profiles.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/profiles/create", [&profiles](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const std::string clone_from =
          body.value("cloneFrom", arg_string(args, 1, body.value("clone_from", "")));
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, profiles.create(id, clone_from));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/profiles/switch", [&profiles, &profile_ctx](const httplib::Request& req,
                                                            httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      if (id.empty()) throw std::runtime_error("id required");
      json p = profiles.switch_to(id);
      profile_ctx.reload_from_disk();
      json_ok(res, p);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_profile = [&profiles](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      profiles.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/profiles/delete", delete_profile);

  svr.Get("/v1/soul/get", [&soul](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, soul.get());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/soul/set", [&soul](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, soul.set(input));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto reset_soul = [&soul](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, soul.reset());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/soul/reset", reset_soul);

  svr.Get("/v1/orchestrator-prompts/defaults",
          [](const httplib::Request&, httplib::Response& res) {
            try {
              json_ok(res, orchestrator_prompt_defaults_json());
            } catch (const std::exception& e) {
              json_err(res, 500, e.what());
            }
          });

  svr.Get("/v1/cron/list", [&cron, &events](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, cron.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/cron/save", [&cron, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, cron.save(input));
      emit_cron_changed(events);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_cron = [&cron, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      cron.remove(id);
      emit_cron_changed(events);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/cron/delete", delete_cron);

  svr.Post("/v1/cron/pause", [&cron, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const bool paused = body.contains("paused") ? body.value("paused", true) : arg_int(args, 1, 1) != 0;
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, cron.pause(id, paused));
      emit_cron_changed(events);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/cron/runNow", [&](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, cron.run_now(id, chat, memory));
      emit_cron_changed(events);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/kanban/list", [&kanban](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, kanban.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/kanban/save", [&kanban, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, kanban.save(input));
      emit_kanban_changed(events);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/kanban/move", [&kanban, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const std::string status = body.value("status", arg_string(args, 1, ""));
      if (id.empty() || status.empty()) throw std::runtime_error("id and status required");
      json_ok(res, kanban.move(id, status));
      emit_kanban_changed(events);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_kanban = [&kanban, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      kanban.remove(id);
      emit_kanban_changed(events);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/kanban/delete", delete_kanban);

  svr.Post("/v1/kanban/dispatch", [&](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const std::string model = config.load().value("defaultModel", "");
      json_ok(res, kanban.dispatch(id, chat, model));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/tools/list", [&tools](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, tools.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/tools/toggle", [&tools](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string name = arg_string(args, 0, body.value("name", ""));
      const bool enabled = body.contains("enabled") ? body.value("enabled", true)
                                                    : (args.size() > 1 && args[1].is_boolean()
                                                           ? args[1].get<bool>()
                                                           : true);
      if (name.empty()) throw std::runtime_error("name required");
      tools.toggle(name, enabled);
      json_ok(res, json{{"name", name}, {"enabled", enabled}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/tools/run", [&tools](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string name = arg_string(args, 0, body.value("name", ""));
      json tool_args = body.contains("args") ? body["args"]
                     : args.size() > 1          ? args[1]
                                                : json::object();
      if (name.empty()) throw std::runtime_error("name required");
      json_ok(res, tools.run(name, tool_args));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/tool/approve/resolve", [&tools](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = id_from_ipc_body(req);
      bool approved = false;
      if (body.is_object()) {
        approved = body.value("approved", false);
      } else if (args.is_array() && args.size() > 1 && args[1].is_boolean()) {
        approved = args[1].get<bool>();
      }
      if (id.empty()) throw std::runtime_error("id required");
      if (!tools.approvals().resolve_tool(id, approved)) {
        json_ok(res, json{{"id", id}, {"approved", approved}, {"status", "expired"}});
        return;
      }
      json_ok(res, json{{"id", id}, {"approved", approved}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/tool/approve/pending", [&tools](const httplib::Request&, httplib::Response& res) {
    json_ok(res, tools.approvals().list_pending_tools());
  });

  svr.Post("/v1/capability/permission/resolve",
           [&tools](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = parse_body(req);
               const json args = args_from_body(req);
               const std::string id = id_from_ipc_body(req);
               bool approved = false;
               if (body.is_object()) {
                 approved = body.value("approved", false);
               } else if (args.is_array() && args.size() > 1 && args[1].is_boolean()) {
                 approved = args[1].get<bool>();
               }
               const bool remember = body.is_object() && body.value("remember", false);
               if (id.empty()) throw std::runtime_error("id required");
               if (!tools.resolve_capability_permission(id, approved, remember)) {
                 json_err(res, 404, "capability approval not found");
                 return;
               }
               json_ok(res, json{{"id", id}, {"approved", approved}});
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
            }
           });

  svr.Get("/v1/capability/permission/pending",
          [&tools](const httplib::Request&, httplib::Response& res) {
            json_ok(res, tools.approvals().list_pending_capabilities());
          });

  svr.Post("/v1/chat/send", [&chat, &debug_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = body_object(req);
      debug_store.log("chat", "send stream=" + body.value("streamId", ""), "info");
      json_ok(res, chat.send(body));
    } catch (const std::exception& e) {
      debug_store.log("chat", e.what(), "error");
      json_err(res, 500, e.what());
    }
  });

  auto abort_chat = [&chat](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      std::string stream_id = id_from_ipc_request(req);
      if (stream_id.empty()) {
        stream_id = arg_string(args, 0, body.value("streamId", body.value("stream_id", "")));
      }
      if (stream_id.empty()) throw std::runtime_error("streamId required");
      json_ok(res, chat.abort(stream_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/chat/abort", abort_chat);

  svr.Get("/v1/chat/stream/poll", [&chat](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string stream_id = req.get_param_value("streamId").empty()
                                        ? req.get_param_value("stream_id")
                                        : req.get_param_value("streamId");
      size_t cursor = 0;
      if (!req.get_param_value("cursor").empty()) {
        cursor = static_cast<size_t>(std::stoul(req.get_param_value("cursor")));
      }
      json_ok(res, chat.poll_stream(stream_id, cursor));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/agent/run", [&agent](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const json payload = args.size() > 0 && args[0].is_object() ? args[0] : body;
      json_ok(res, agent.run(payload));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto abort_agent = [&agent](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, agent.abort());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/agent/abort", abort_agent);

  svr.Get("/v1/providers/list", [&providers](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, providers.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/providers/save", [&providers, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, providers.save(input));
      events.publish("omega:providers:changed", json::object());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_provider = [&providers, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      providers.remove(id);
      events.publish("omega:providers:changed", json::object());
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/providers/delete", delete_provider);

  svr.Post("/v1/providers/fetchModels", [&providers](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const bool persist = body.value("persist", false);
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, providers.fetch_models(id, persist));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/providers/presets", [&providers](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, providers.presets());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/providers/discover", [&providers](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, providers.discover_all());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/input-pipelines/list", [&input_pipelines](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, input_pipelines.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/input-pipelines/get", [&input_pipelines](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = req.get_param_value("id").empty() ? arg_string(args, 0, "")
                                                               : req.get_param_value("id");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, input_pipelines.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/input-pipelines/get", [&input_pipelines](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, input_pipelines.get(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/input-pipelines/save", [&input_pipelines](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, input_pipelines.save(input));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_input_pipeline = [&input_pipelines](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      input_pipelines.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/input-pipelines/delete", delete_input_pipeline);

  svr.Post("/v1/input-pipelines/set-active",
           [&input_pipelines](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = parse_body(req);
               const json args = args_from_body(req);
               const std::string scope = arg_string(args, 0, body.value("scope", "chat"));
               const std::string id = arg_string(args, 1, body.value("id", ""));
               if (id.empty()) throw std::runtime_error("id required");
               json_ok(res, input_pipelines.set_active(scope, id));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Get("/v1/context/buffer", [&](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string session_id = req.get_param_value("sessionId").empty()
                                         ? req.get_param_value("session_id")
                                         : req.get_param_value("sessionId");
      const std::string model_id = req.get_param_value("modelId").empty()
                                       ? req.get_param_value("model_id")
                                       : req.get_param_value("modelId");
      if (session_id.empty()) throw std::runtime_error("sessionId required");
      const json msgs = sessions.get_messages(session_id);
      int tokens = 0;
      if (msgs.is_array()) {
        for (const auto& m : msgs) tokens += estimate_tokens(m.value("content", ""));
      }
      const json cfg = config.load();
      int max_context = cfg.value("contextSize", 8192);
      if (!model_id.empty() && cfg.contains("modelConfigs") && cfg["modelConfigs"].is_object()) {
        for (auto it = cfg["modelConfigs"].begin(); it != cfg["modelConfigs"].end(); ++it) {
          if (it.key() == model_id && it.value().contains("contextSize")) {
            max_context = it.value().value("contextSize", max_context);
            break;
          }
        }
      }
      json_ok(res, json{{"sessionId", session_id},
                        {"modelId", model_id},
                        {"tokenEstimate", tokens},
                        {"messageCount", msgs.is_array() ? msgs.size() : 0},
                        {"maxContext", max_context}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/plugins/list", [&plugins](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, plugins.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/plugins/catalog", [&plugins](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, plugins.catalog());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/plugins/toggle", [&plugins](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("id", ""));
      const bool enabled = args.size() > 1 && args[1].is_boolean()
                               ? args[1].get<bool>()
                               : body.value("enabled", true);
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, plugins.toggle(id, enabled));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/plugins/reload", [&plugins](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, plugins.reload());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/plugins/installBuiltin", [&plugins](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_body(req);
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, plugins.install_builtin(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/plugins/installUrl", [&plugins](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = parse_body(req);
      std::string url = arg_string(args, 0, "");
      if (url.empty() && body.is_object()) url = body.value("url", "");
      if (url.empty() && body.is_string()) url = body.get<std::string>();
      if (url.empty()) throw std::runtime_error("url required");
      json_ok(res, plugins.install_from_url(url));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto uninstall_plugin = [&plugins](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      plugins.uninstall(id);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/plugins/uninstall", uninstall_plugin);

  svr.Get("/v1/mcp/list", [&mcp](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, mcp.list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/mcp/save", [&mcp](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, mcp.save(input));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_mcp = [&mcp, &mcp_clients](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      (void)mcp_clients.stop(id);
      mcp.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/mcp/delete", delete_mcp);

  svr.Get("/v1/mcp/status", [&mcp_clients](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, mcp_clients.status_list());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/mcp/start", [&mcp_clients](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_body(req);
      if (id.empty()) throw std::runtime_error("id required");
      std::thread([&mcp_clients, id]() {
        try {
          mcp_clients.start(id);
        } catch (...) {
        }
      }).detach();
      json_ok(res, json{{"id", id}, {"state", "starting"}, {"toolCount", 0}, {"resourceCount", 0}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto stop_mcp = [&mcp_clients](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, mcp_clients.stop(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/mcp/stop", stop_mcp);

  svr.Post("/v1/mcp", [&](const httplib::Request& req, httplib::Response& res) {
    try {
      const json result = handle_omega_mcp_request(req.body, sessions, memory, tools);
      if (result.is_object() && result.empty()) {
        res.status = 204;
        return;
      }
      json_ok(res, result);
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/gateway/platforms", [&gateway](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, gateway.platforms());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/gateway/list", [&gateway](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, gateway.list_configs());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/gateway/save", [&gateway, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json input = args.size() > 0 && args[0].is_object() ? args[0] : parse_body(req);
      json_ok(res, gateway.save_config(input));
      events.publish("omega:gateway:statusChanged", gateway.list_statuses());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_gateway = [&gateway, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      gateway.delete_config(id);
      events.publish("omega:gateway:statusChanged", gateway.list_statuses());
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/gateway/delete", delete_gateway);

  svr.Post("/v1/gateway/start", [&gateway, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string_or_body(req, args, 0, "id");
      if (id.empty()) throw std::runtime_error("id required");
      json_ok(res, gateway.start_platform(id));
      events.publish("omega:gateway:statusChanged", gateway.list_statuses());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto stop_gateway = [&gateway, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      gateway.stop_platform(id);
      events.publish("omega:gateway:statusChanged", gateway.list_statuses());
      json_ok(res, json{{"stopped", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/gateway/stop", stop_gateway);

  svr.Get("/v1/gateway/status", [&gateway](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, gateway.list_statuses());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post(R"(/v1/gateway/([a-z]+))", [&gateway](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = req.matches.size() > 1 ? req.matches[1].str() : "";
      if (id.empty()) throw std::runtime_error("gateway id required");
      json_ok(res, gateway.handle_inbound(id, parse_body(req)));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/engines/status", [&engine](const httplib::Request&, httplib::Response& res) {
    try {
      json health = json::object();
      try {
        health = engine.command("health", json::object(), 5000);
      } catch (...) {
      }
      json_ok(res, json{{"omegaEngine",
                         json{{"name", "omega-engine"},
                              {"present", engine.available()},
                              {"available", engine.available()},
                              {"health", health}}},
                        {"ollama", OllamaSupervisor::instance().status()}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/inference/backend", [&engine](const httplib::Request&, httplib::Response& res) {
    json_ok(res, json{{"id", "engine"}, {"available", engine.available()}});
  });

  svr.Get("/v1/inference/backends", [&engine](const httplib::Request&, httplib::Response& res) {
    json_ok(res, json::array({json{{"id", "engine"},
                                    {"label", "omega-engine (libomega_infer)"},
                                    {"available", engine.available()}}}));
  });

  svr.Post("/v1/inference/switch", [&engine, &config](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string model = arg_string(args, 0, body.value("modelId", body.value("model", "")));
      if (model.empty()) throw std::runtime_error("modelId required");
      json payload{{"modelId", model}};
      if (body.contains("forceLoad")) payload["forceLoad"] = body["forceLoad"];
      const json loaded =
          engine.command("model.load", build_model_load_payload(config, model, payload), 600000);
      json_ok(res, json{{"activeModel", loaded.value("activeModelId", model)}});
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/inference/media/capabilities",
          [&engine](const httplib::Request&, httplib::Response& res) {
            try {
              MediaExecutor::refresh_capabilities(engine);
              json caps = MediaExecutor::capabilities_json();
              caps["policy"] = "engine_native_ollama_explicit";
              caps["contentStudioStorage"] = resolve_content_studio_storage();
              caps["studioSubprocess"] = json{
                  {"ready", studio_media::subprocess_ready()},
                  {"pythonReady", std::filesystem::exists(resolve_unified_python())},
                  {"scriptReady", std::filesystem::exists(resolve_content_studio_native_media_script())},
                  {"backendReady", std::filesystem::exists(resolve_content_studio_backend())}};
              caps["contentStudioGeneration"] = ContentStudioSettings::generation_media_summary();
              caps["nativeFallback"] = json{
                  {"studioImagesOnEngineFailure", true}, {"studioTtsOnSilentWavs", true}};
              json_ok(res, caps);
            } catch (const std::exception& e) {
              json_err(res, 503, e.what());
            }
          });

  svr.Post("/v1/inference/media/image",
           [&config, &engine](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = parse_body(req);
               const std::string prompt = body.value("prompt", "");
               if (prompt.empty()) throw std::runtime_error("prompt required");
               const json cfg = config.load();
               const json img_cfg = cfg.value("imageGeneration", json::object());
               const int width = body.value("width", img_cfg.value("width", 1024));
               const int height = body.value("height", img_cfg.value("height", 1024));
               const std::string model =
                   body.value("modelId", body.value("model", img_cfg.value("ollamaModel", "flux")));
               MediaExecutor::refresh_capabilities(engine);
               const ImageGenerateResult img =
                   MediaExecutor::generate_image(&engine, cfg, model, prompt, width, height);
               if (!img.ok) {
                 json_err(res, 503, img.error);
                 return;
               }
               json out{{"ok", true},
                        {"backend", img.backend},
                        {"ollamaFallback", img.ollama_fallback},
                        {"pngBase64", ""}};
               if (!img.png_bytes.empty()) {
                 const std::string raw(img.png_bytes.begin(), img.png_bytes.end());
                 out["pngBase64"] = httplib::detail::base64_encode(raw);
               }
               json_ok(res, out);
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Post("/v1/inference/media/tts",
           [&config, &engine](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = parse_body(req);
               const std::string text = body.value("text", "");
               if (text.empty()) throw std::runtime_error("text required");
               const std::string out_path = body.value("outPath", body.value("out_path", ""));
               if (out_path.empty()) throw std::runtime_error("outPath required");
               const json cfg = config.load();
               const json tts_cfg = cfg.value("ttsGeneration", json::object());
               const std::string model = body.value("modelId", body.value("model", tts_cfg.value("modelId", "")));
               MediaExecutor::refresh_capabilities(engine);
               const TtsGenerateResult tts =
                   MediaExecutor::generate_tts(&engine, cfg, model, text, out_path);
               if (!tts.ok) {
                 json_err(res, 503, tts.error);
                 return;
               }
               json_ok(res, json{{"ok", true}, {"backend", tts.backend}, {"wavPath", tts.wav_path}});
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Post("/v1/project/open", [&projects](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("sessionId", body.value("id", "")));
      if (id.empty()) throw std::runtime_error("sessionId required");
      json_ok(res, json{{"path", projects.open_folder(id)}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/project/list", [&projects](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, body.value("sessionId", body.value("id", "")));
      if (id.empty()) throw std::runtime_error("sessionId required");
      json_ok(res, projects.list_files(id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/pipeline/activity", [&pipeline_activity](const httplib::Request&, httplib::Response& res) {
    json_ok(res, pipeline_activity.snapshot());
  });

  svr.Get("/v1/debug/history", [&debug_store](const httplib::Request&, httplib::Response& res) {
    json_ok(res, debug_store.history());
  });

  svr.Post("/v1/debug/log", [&debug_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const std::string message = body.value("message", "");
      if (message.empty()) {
        json_err(res, 400, "message required");
        return;
      }
      const std::string source = body.value("source", "python");
      const std::string level = body.value("level", "info");
      const json data = body.contains("data") && body["data"].is_object() ? body["data"] : json::object();
      debug_store.log(source, message, level, data);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Get("/v1/content-studio/status", [&content_studio](const httplib::Request&, httplib::Response& res) {
    json_ok(res, content_studio.status());
  });

  svr.Post("/v1/content-studio/native/render",
           [&config, &engine](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = parse_body(req);
               json result = content_studio_native::run_production_bundle(config, engine, body);
               if (!result.value("ok", false)) {
                 json_err(res, 503, result.value("error", "native render failed"));
                 return;
               }
               json_ok(res, result);
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Post("/v1/content-studio/webhook", [&content_job_delivery, &events, &debug_store](
                                             const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const std::string job_id = body.value("job_id", body.value("jobId", ""));
      debug_store.log("content-studio", "webhook job=" + job_id + " status=" + body.value("status", ""),
                      "info");
      json_ok(res, content_job_delivery.handle_webhook(body, events));
    } catch (const std::exception& e) {
      debug_store.log("content-studio", std::string("webhook failed: ") + e.what(), "error");
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/content-studio/registerJob", [&content_job_delivery](const httplib::Request& req,
                                                                     httplib::Response& res) {
    json_ok(res, content_job_delivery.register_job(body_object(req)));
  });

  svr.Post("/v1/content-studio/ensureCard", [&content_job_delivery, &events](const httplib::Request& req,
                                                                              httplib::Response& res) {
    json_ok(res, content_job_delivery.ensure_card(body_object(req), events));
  });

  svr.Post("/v1/content-studio/start", [&content_studio](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, content_studio.start());
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  auto stop_content_studio = [&content_studio](const httplib::Request&, httplib::Response& res) {
    json_ok(res, content_studio.stop());
  };
  register_post_and_delete(svr, "/v1/content-studio/stop", stop_content_studio);

  svr.Post("/v1/content-studio/restart", [&content_studio](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, content_studio.restart());
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  auto cs_proxy_get = [&content_studio, &debug_store](const char* api_path) {
    return [&content_studio, &debug_store, api_path](const httplib::Request&, httplib::Response& res) {
      try {
        content_studio.ensure_started();
        debug_store.log("content-studio", std::string("API GET ") + api_path, "info");
        json_ok(res, content_studio.api("GET", api_path));
      } catch (const std::exception& e) {
        debug_store.log("content-studio", std::string("API GET ") + api_path + " failed: " + e.what(),
                        "error");
        json_err(res, 503, e.what());
      }
    };
  };

  auto cs_proxy_post = [&content_studio, &debug_store](const char* api_path) {
    return [&content_studio, &debug_store, api_path](const httplib::Request& req, httplib::Response& res) {
      try {
        content_studio.ensure_started();
        debug_store.log("content-studio", std::string("API POST ") + api_path, "info");
        json_ok(res, content_studio.api("POST", api_path, body_object(req)));
      } catch (const std::exception& e) {
        debug_store.log("content-studio", std::string("API POST ") + api_path + " failed: " + e.what(),
                        "error");
        json_err(res, 503, e.what());
      }
    };
  };

  svr.Get("/v1/content-studio/projects", cs_proxy_get("/api/agent/v1/projects"));
  svr.Post("/v1/content-studio/createRun", cs_proxy_post("/api/agent/v1/runs"));

  svr.Post("/v1/content-studio/runStatus", [&content_studio](const httplib::Request& req, httplib::Response& res) {
    const std::string id = id_from_ipc_body(req);
    if (id.empty()) {
      json_err(res, 400, "jobId required");
      return;
    }
    try {
      json st;
      if (const auto native = get_content_studio_run_status_native(id)) {
        st = *native;
      } else {
        content_studio.ensure_started();
        st = content_studio.api("GET", "/api/agent/v1/runs/" + id);
      }
      std::string project_id = st.value("project_id", st.value("projectId", ""));
      if (project_id.empty()) {
        if (const auto hint = find_cs_project_for_job(id)) project_id = *hint;
      }
      apply_cs_disk_success(st, project_id, id);
      json_ok(res, st);
    } catch (const std::exception& e) {
      if (const auto project_id = find_cs_project_for_job(id)) {
        json st = json{{"job_id", id},
                       {"id", id},
                       {"project_id", *project_id},
                       {"status", "succeeded"},
                       {"video_ready", true},
                       {"worker_running", false},
                       {"mp4_path", *project_id + "/" + id + "/final.mp4"}};
        json_ok(res, st);
        return;
      }
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/content-studio/jobMedia", [](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string project_id = req.get_param_value("projectId");
      if (project_id.empty()) project_id = req.get_param_value("project_id");
      std::string job_id = req.get_param_value("jobId");
      if (job_id.empty()) job_id = req.get_param_value("job_id");
      if (project_id.empty() || job_id.empty()) {
        json_err(res, 400, "projectId and jobId required");
        return;
      }
      if (project_id.find("..") != std::string::npos || job_id.find("..") != std::string::npos ||
          project_id.find('/') != std::string::npos || project_id.find('\\') != std::string::npos ||
          job_id.find('/') != std::string::npos || job_id.find('\\') != std::string::npos) {
        json_err(res, 400, "invalid id");
        return;
      }
      const fs::path path =
          fs::path(resolve_content_studio_storage()) / project_id / job_id / "final.mp4";
      serve_binary_file(res, path.string());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/content-studio/forceStopJob",
           [&content_studio](const httplib::Request& req, httplib::Response& res) {
             try {
               json_ok(res, content_studio.force_stop_job(body_object(req)));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Get("/v1/content-studio/schedules", cs_proxy_get("/api/agent/v1/schedules"));
  svr.Post("/v1/content-studio/scheduleCreate", cs_proxy_post("/api/agent/v1/schedules"));

  svr.Post("/v1/content-studio/scheduleDelete",
           [&content_studio](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string id = id_from_ipc_body(req);
               if (id.empty()) throw std::runtime_error("id required");
               content_studio.ensure_started();
               content_studio.api("DELETE", "/api/agent/v1/schedules/" + id);
               json_ok(res, json{{"deleted", true}});
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Get("/v1/content-studio/socialPlatforms", cs_proxy_get("/api/social/platforms"));
  svr.Get("/v1/content-studio/socialAccounts", cs_proxy_get("/api/social/accounts"));
  svr.Get("/v1/content-studio/socialPosts", cs_proxy_get("/api/social/posts"));
  svr.Post("/v1/content-studio/socialPublish", cs_proxy_post("/api/social/posts"));

  svr.Get("/v1/content-studio/credentialsGet",
          [&cs_settings](const httplib::Request&, httplib::Response& res) {
            json_ok(res, cs_settings.load_credentials());
          });
  svr.Post("/v1/content-studio/credentialsGet",
           [&cs_settings](const httplib::Request&, httplib::Response& res) {
             json_ok(res, cs_settings.load_credentials());
           });

  svr.Post("/v1/content-studio/credentialsSet",
           [&content_studio, &cs_settings](const httplib::Request& req, httplib::Response& res) {
             try {
               const json saved = cs_settings.save_credentials(body_object(req));
               try {
                 content_studio.ensure_started();
                 json payload =
                     cs_settings.credentials_to_api_payload(saved);
                 const json gen =
                     cs_settings.generation_to_api_payload(cs_settings.load_generation());
                 for (auto it = gen.begin(); it != gen.end(); ++it) payload[it.key()] = it.value();
                 content_studio.api("PUT", "/api/agent/v1/credentials", payload);
               } catch (...) {
               }
               json_ok(res, saved);
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Post("/v1/content-studio/credentialsSync",
           [&content_studio, &cs_settings](const httplib::Request&, httplib::Response& res) {
             try {
               content_studio.ensure_started();
               json payload =
                   cs_settings.credentials_to_api_payload(cs_settings.load_credentials());
               const json gen =
                   cs_settings.generation_to_api_payload(cs_settings.load_generation());
               for (auto it = gen.begin(); it != gen.end(); ++it) payload[it.key()] = it.value();
               json_ok(res, content_studio.api("PUT", "/api/agent/v1/credentials", payload));
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Get("/v1/content-studio/credentialsStatus",
          [&content_studio](const httplib::Request&, httplib::Response& res) {
            try {
              content_studio.ensure_started();
              const json r = content_studio.api("GET", "/api/agent/v1/credentials/status");
              json_ok(res, r.contains("platforms") ? r["platforms"] : r);
            } catch (const std::exception& e) {
              json_ok(res, json::object());
            }
          });
  svr.Post("/v1/content-studio/credentialsStatus",
           [&content_studio](const httplib::Request&, httplib::Response& res) {
             try {
               content_studio.ensure_started();
               const json r = content_studio.api("GET", "/api/agent/v1/credentials/status");
               json_ok(res, r.contains("platforms") ? r["platforms"] : r);
             } catch (const std::exception&) {
               json_ok(res, json::object());
             }
           });

  svr.Post("/v1/content-studio/youtubeConnect", [&content_studio, &cs_settings, &events](const httplib::Request&, httplib::Response& res) {
    try { json_ok(res, content_studio.connect_youtube_oauth(events, cs_settings)); } catch (const std::exception& e) { json_err(res, 503, e.what()); }
  });

  svr.Get("/v1/content-studio/seriesList", cs_proxy_get("/api/agent/v1/series"));
  svr.Post("/v1/content-studio/seriesCreate", cs_proxy_post("/api/agent/v1/series"));

  svr.Post("/v1/content-studio/seriesDelete",
           [&content_studio](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string id = id_from_ipc_body(req);
               if (id.empty()) throw std::runtime_error("id required");
               content_studio.ensure_started();
               content_studio.api("DELETE", "/api/agent/v1/series/" + id);
               json_ok(res, json{{"deleted", true}});
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Get("/v1/content-studio/generationGet",
          [&cs_settings](const httplib::Request&, httplib::Response& res) {
            json_ok(res, cs_settings.load_generation());
          });

  svr.Post("/v1/content-studio/generationSet",
           [&content_studio, &cs_settings](const httplib::Request& req, httplib::Response& res) {
             try {
               const json saved = cs_settings.save_generation(body_object(req));
               std::string sync_warning;
               try {
                 content_studio.ensure_started();
                 json payload =
                     cs_settings.credentials_to_api_payload(cs_settings.load_credentials());
                 const json gen = cs_settings.generation_to_api_payload(saved);
                 for (auto it = gen.begin(); it != gen.end(); ++it) payload[it.key()] = it.value();
                 content_studio.api("PUT", "/api/agent/v1/credentials", payload);
               } catch (const std::exception& e) {
                 sync_warning = e.what();
               }
               json out = saved;
               if (!sync_warning.empty()) out["syncWarning"] = sync_warning;
               json_ok(res, out);
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Get("/v1/content-studio/generationCatalog",
          [&cs_settings](const httplib::Request&, httplib::Response& res) {
            json_ok(res, cs_settings.local_generation_catalog());
          });

  svr.Get("/v1/content-studio/generationCapabilities",
          [&content_studio](const httplib::Request& req, httplib::Response& res) {
            try {
              std::string modality = req.get_param_value("modality");
              std::string repo_id = req.get_param_value("repoId");
              if (repo_id.empty()) repo_id = req.get_param_value("repo_id");
              if (modality.empty() || repo_id.empty()) {
                json_err(res, 400, "modality and repoId required");
                return;
              }
              content_studio.ensure_started();
              json_ok(res, content_studio.invoke_cli(
                                    "probe-capabilities",
                                    json{{"modality", modality}, {"repo_id", repo_id}}));
            } catch (const std::exception& e) {
              json_err(res, 503, e.what());
            }
          });

  svr.Post("/v1/content-studio/generationDownload", [&content_studio, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = parse_body(req);
      json_ok(res, content_studio.download_generation_model(body, events));
    } catch (const std::exception& e) { json_err(res, 503, e.what()); }
  });

  svr.Get("/v1/model-config/list", [&model_config](const httplib::Request&, httplib::Response& res) {
    json_ok(res, model_config.list());
  });

  svr.Get("/v1/model-config/get", [&model_config](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_config.get(id));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/model-config/set", [&model_config](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      std::string id = arg_string(args, 0, "");
      json patch = args.size() > 1 ? args[1] : json::object();
      if (id.empty()) {
        const json body = body_object(req);
        id = body.value("modelId", "");
        patch = body.contains("patch") ? body["patch"] : body;
        patch.erase("modelId");
      }
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_config.set(id, patch));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Delete("/v1/model-config/reset", [&model_config](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_config.reset(id));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Get("/v1/model-presets/list", [](const httplib::Request&, httplib::Response& res) {
    json_ok(res, list_model_presets());
  });

  svr.Post("/v1/model-presets/apply", [&model_config](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      std::string model_id = arg_string(args, 0, "");
      std::string preset_id = arg_string(args, 1, "");
      if (model_id.empty() || preset_id.empty()) {
        const json body = body_object(req);
        model_id = body.value("modelId", model_id);
        preset_id = body.value("presetId", preset_id);
      }
      if (model_id.empty() || preset_id.empty()) throw std::runtime_error("modelId and presetId required");
      json_ok(res, apply_model_preset(model_config, model_id, preset_id));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Get("/v1/model/inspect", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_meta.inspect(id));
    } catch (const std::exception& e) {
      json_err(res, 404, e.what());
    }
  });

  svr.Get("/v1/model/estimate", [&model_meta, &model_config](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json cfg = model_config.get(id);
      if (req.has_param("gpuTotalMb")) cfg = body_object(req);
      int gpu_total = req.has_param("gpuTotalMb") ? std::stoi(req.get_param_value("gpuTotalMb")) : 0;
      int gpu_budget = req.has_param("gpuBudgetMb") ? std::stoi(req.get_param_value("gpuBudgetMb")) : 0;
      json_ok(res, model_meta.estimate(id, cfg, gpu_total, gpu_budget));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/model/estimate", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string id = arg_string(args, 0, "");
      if (id.empty()) throw std::runtime_error("modelId required");
      const json cfg = args.size() > 1 ? args[1] : json::object();
      const int gpu_total = args.size() > 2 ? arg_int(args, 2, 0) : 0;
      const int gpu_budget = args.size() > 3 ? arg_int(args, 3, 0) : 0;
      json_ok(res, model_meta.estimate(id, cfg, gpu_total, gpu_budget));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Get("/v1/model/estimateFile", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      int64_t size = 0;
      if (req.has_param("size")) size = std::stoll(req.get_param_value("size"));
      int context = req.has_param("context") ? std::stoi(req.get_param_value("context")) : 4096;
      const std::string quant = req.has_param("quant") ? req.get_param_value("quant") : "";
      if (size <= 0) throw std::runtime_error("size required");
      json_ok(res, model_meta.estimate_file(size, context, quant));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/model/estimateFile", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const int64_t size = args.size() > 0 && args[0].is_number_integer() ? args[0].get<int64_t>() : 0;
      const int context = args.size() > 1 ? arg_int(args, 1, 4096) : 4096;
      const std::string quant = arg_string(args, 2, "");
      if (size <= 0) throw std::runtime_error("size required");
      json_ok(res, model_meta.estimate_file(size, context, quant));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Get("/v1/models/footprint", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_meta.footprint(id));
    } catch (const std::exception& e) {
      json_err(res, 404, e.what());
    }
  });

  svr.Get("/v1/models/benchmark", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_meta.benchmark(id));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/models/benchmark", [&model_meta](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) throw std::runtime_error("modelId required");
      json_ok(res, model_meta.benchmark(id));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/models/check-hf-access", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      std::string repo = arg_string(args, 0, "");
      if (repo.empty()) repo = body_object(req).value("repo", "");
      if (repo.empty()) throw std::runtime_error("repo required");
      json_ok(res, hf_client.check_repo_access(repo));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/models/repo-files", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string repo = arg_string(args_from_body(req), 0, "");
      if (repo.empty()) throw std::runtime_error("repo required");
      json_ok(res, hf_client.repo_file_paths(repo));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/models/open-hf-repo", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string repo = arg_string(args_from_body(req), 0, "");
      if (repo.empty()) throw std::runtime_error("repo required");
      std::string trimmed = repo;
      while (!trimmed.empty() && (trimmed.front() == '/')) trimmed.erase(trimmed.begin());
      while (!trimmed.empty() && (trimmed.back() == '/')) trimmed.pop_back();
      const std::string page_url = "https://huggingface.co/" + trimmed;
      json nav = desktop_aux.browser_navigate(page_url, events);
      json_ok(res, json{{"opened", nav.value("opened", true)},
                        {"pageUrl", page_url}});
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/hf/search", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      json_ok(res, hf_client.search(body_object(req)));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/hf/search", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      json opts = json::object();
      if (req.has_param("query")) opts["query"] = req.get_param_value("query");
      if (req.has_param("author")) opts["author"] = req.get_param_value("author");
      if (req.has_param("limit")) opts["limit"] = std::stoi(req.get_param_value("limit"));
      json_ok(res, hf_client.search(opts));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/hf/card", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string repo = req.has_param("repo") ? req.get_param_value("repo") : model_id_from_req(req);
      if (repo.empty()) throw std::runtime_error("repo required");
      json_ok(res, hf_client.model_card(repo));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/hf/card", [&hf_client](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string repo = arg_string(args_from_body(req), 0, "");
      if (repo.empty()) throw std::runtime_error("repo required");
      json_ok(res, hf_client.model_card(repo));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/hf/tags", [&hf_client](const httplib::Request&, httplib::Response& res) {
    json_ok(res, hf_client.common_tags());
  });

  svr.Get("/v1/gpu/list", [](const httplib::Request&, httplib::Response& res) {
    json_ok(res, list_gpu_devices());
  });

  svr.Get("/v1/memory/projectContext",
          [&memory, &projects, &config](const httplib::Request& req, httplib::Response& res) {
            namespace fs = std::filesystem;
            try {
              std::string session_id = req.has_param("sessionId") ? req.get_param_value("sessionId") : "";
              if (session_id.empty() && !req.body.empty()) {
                const json args = args_from_body(req);
                session_id = arg_string(args, 0, "");
              }
              const json cfg = config.load();
              const std::string sandbox = cfg.value("sandboxRoot", "");
              const std::string workspace =
                  session_id.empty() ? sandbox : projects.open_folder(session_id);
              const std::string ws_name = fs::path(workspace).filename().string();
              const json all = memory.list(400);
              json workspace_entries = json::array();
              for (const auto& e : all) {
                if (!e.is_object()) continue;
                const std::string content = e.value("content", "");
                const std::string kind = e.value("kind", "");
                if (content.find(workspace) != std::string::npos ||
                    content.find(ws_name) != std::string::npos || kind == "preference" ||
                    kind == "task") {
                  workspace_entries.push_back(e);
                  if (workspace_entries.size() >= 24) break;
                }
              }
              json session_entries = json::array();
              if (!session_id.empty()) {
                for (const auto& e : all) {
                  if (e.value("sessionId", "") == session_id) {
                    session_entries.push_back(e);
                    if (session_entries.size() >= 24) break;
                  }
                }
              }
              json out{{"workspace", workspace}, {"workspaceEntries", workspace_entries},
                       {"sessionEntries", session_entries}};
              if (!session_id.empty()) {
                out["projectDir"] = workspace;
                out["projectFileCount"] = projects.list_files(session_id).size();
              }
              json_ok(res, out);
            } catch (const std::exception& e) {
              json_err(res, 500, e.what());
            }
          });

  svr.Get("/v1/finetune/list", [&finetune](const httplib::Request&, httplib::Response& res) {
    json_ok(res, finetune.list());
  });

  svr.Post("/v1/finetune/analyze", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = model_id_from_req(req);
      if (id.empty()) {
        const json args = args_from_body(req);
        const std::string from_args = arg_string(args, 0, "");
        if (from_args.empty()) throw std::runtime_error("modelId required");
        json_ok(res, analyze_model_for_finetune(from_args));
        return;
      }
      json_ok(res, analyze_model_for_finetune(id));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/finetune/prepareDataset",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             try {
               json_ok(res, finetune_datasets.prepare_dataset(body_object(req)));
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Get("/v1/finetune/listDatasets",
          [&finetune_datasets](const httplib::Request&, httplib::Response& res) {
            json_ok(res, finetune_datasets.list_prepared());
          });

  svr.Get("/v1/finetune/listPresets",
          [&finetune_datasets](const httplib::Request&, httplib::Response& res) {
            json_ok(res, finetune_datasets.list_presets());
          });

  svr.Post("/v1/finetune/savePreset",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             try {
               json_ok(res, finetune_datasets.save_preset(body_object(req)));
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Post("/v1/finetune/deletePreset",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string id = id_from_ipc_body(req);
               if (id.empty()) throw std::runtime_error("id required");
               finetune_datasets.delete_preset(id);
               json_ok(res, json{{"deleted", true}});
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Post("/v1/finetune/inspectSource",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             try {
               const json args = args_from_body(req);
               std::string path = arg_string(args, 0, "");
               if (path.empty()) path = body_object(req).value("path", "");
               if (path.empty()) throw std::runtime_error("path required");
               json_ok(res, finetune_datasets.inspect_source(path));
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Post("/v1/finetune/pickSources",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             json_ok(res, finetune_datasets.pick_sources(body_object(req)));
           });

  svr.Get("/v1/finetune/datasetsRoot",
          [&finetune_datasets](const httplib::Request&, httplib::Response& res) {
            json_ok(res, finetune_datasets.datasets_root());
          });

  svr.Post("/v1/finetune/deletePrepared",
           [&finetune_datasets](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string id = id_from_ipc_body(req);
               if (id.empty()) throw std::runtime_error("id required");
               json_ok(res, json{{"deleted", finetune_datasets.delete_prepared(id)}});
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Post("/v1/finetune/get", [&finetune](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_body(req);
      if (id.empty()) throw std::runtime_error("id required");
      const auto job = finetune.get(id);
      if (!job) throw std::runtime_error("job not found");
      json_ok(res, *job);
    } catch (const std::exception& e) {
      json_err(res, 404, e.what());
    }
  });

  svr.Post("/v1/finetune/create", [&finetune](const httplib::Request& req, httplib::Response& res) {
    try {
      const json input = parse_body(req);
      json_ok(res, finetune.create(input.is_object() ? input : json::object()));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  auto delete_finetune = [&finetune, &finetune_runner](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("id required");
      finetune_runner.abort(id);
      finetune.remove(id);
      json_ok(res, json{{"deleted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/finetune/delete", delete_finetune);

  svr.Post("/v1/finetune/start", [&finetune_runner, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_body(req);
      if (id.empty()) throw std::runtime_error("jobId required");
      json_ok(res, finetune_runner.start(id, events));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  auto abort_finetune = [&finetune_runner](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string id = id_from_ipc_request(req);
      if (id.empty()) throw std::runtime_error("jobId required");
      finetune_runner.abort(id);
      json_ok(res, json{{"aborted", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/finetune/abort", abort_finetune);

  svr.Post("/v1/engines/ollama/start", [](const httplib::Request&, httplib::Response& res) {
    try {
      auto& ollama = OllamaSupervisor::instance();
      if (!ollama.ensure_started()) throw std::runtime_error("failed to start ollama");
      json_ok(res, ollama.status());
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  auto stop_ollama = [](const httplib::Request&, httplib::Response& res) {
    try {
      OllamaSupervisor::instance().stop();
      json_ok(res, json{{"running", false}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/engines/ollama/stop", stop_ollama);

  svr.Get("/v1/engines/ollama/list", [](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, OllamaSupervisor::instance().list_models());
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/engines/ollama/pull", [&events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const json args = args_from_body(req);
      const std::string name = arg_string(args, 0, body.value("name", ""));
      if (name.empty()) throw std::runtime_error("name required");
      const json result = OllamaSupervisor::instance().pull_model(
          name, [&events, &name](const json& progress) {
            json payload = progress;
            if (!payload.contains("name")) payload["name"] = name;
            events.publish("omega:engines:ollama:pullProgress", payload);
          });
      json_ok(res, result);
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/events/poll", [&events](const httplib::Request& req, httplib::Response& res) {
    try {
      size_t cursor = 0;
      if (!req.get_param_value("cursor").empty()) {
        cursor = static_cast<size_t>(std::stoul(req.get_param_value("cursor")));
      }
      int timeout = 5000;
      if (!req.get_param_value("timeout").empty()) {
        timeout = std::stoi(req.get_param_value("timeout"));
      }
      timeout = std::max(100, std::min(timeout, 800));
      const auto evs = events.poll(cursor, timeout);
      const size_t next_cursor = cursor;
      json arr = json::array();
      for (const auto& e : evs) {
        arr.push_back(json{{"channel", e.channel}, {"payload", e.payload}, {"ts", e.ts_ms}});
      }
      json_ok(res, json{{"events", arr}, {"cursor", next_cursor}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/events/sse", [&events](const httplib::Request& req, httplib::Response& res) {
    res.set_header("Cache-Control", "no-cache");
    res.set_header("Connection", "keep-alive");
    auto cursor = std::make_shared<size_t>(0);
    if (!req.get_param_value("cursor").empty()) {
      *cursor = static_cast<size_t>(std::stoul(req.get_param_value("cursor")));
    }
    res.set_content_provider(
        "text/event-stream",
        [cursor, &events](size_t, httplib::DataSink& sink) {
          const auto evs = events.poll(*cursor, 800);
          for (const auto& e : evs) {
            std::string msg = "event: " + e.channel + "\n";
            msg += "data: " + json_dump_safe(e.payload) + "\n\n";
            if (!sink.write(msg.data(), msg.size())) return false;
          }
          if (evs.empty()) {
            const char* ping = ": ping\n\n";
            if (!sink.write(ping, 7)) return false;
          }
          return true;
        },
        [](bool) {});
  });

  svr.Post("/v1/chat/attachment-limits",
           [&chat_attachments](const httplib::Request&, httplib::Response& res) {
             json_ok(res, chat_attachments.limits());
           });

  svr.Post("/v1/chat/pick-attachments",
           [&chat_attachments](const httplib::Request& req, httplib::Response& res) {
             json_ok(res, chat_attachments.pick_paths(body_object(req)));
           });

  svr.Post("/v1/chat/stage-attachment",
           [&chat_attachments](const httplib::Request& req, httplib::Response& res) {
             try {
               const json args = args_from_body(req);
               const json body = body_object(req);
               const std::string session_id =
                   arg_string(args, 0, body.value("sessionId", body.value("session_id", "")));
               if (session_id.empty()) throw std::runtime_error("sessionId required");
               if (body.contains("data") && body["data"].is_string()) {
                 const std::string name = body.value("name", body.value("filename", "attachment"));
                 const std::string mime = body.value("mime", body.value("mimeType", ""));
                 json_ok(res, chat_attachments.stage_encoded(session_id, name, body["data"], mime));
                 return;
               }
               const std::string source_path =
                   arg_string(args, 1, body.value("sourcePath", body.value("path", "")));
               if (source_path.empty()) {
                 throw std::runtime_error("sourcePath or data required");
               }
               json_ok(res, chat_attachments.stage(session_id, source_path));
             } catch (const std::exception& e) {
               json_err(res, 400, e.what());
             }
           });

  svr.Get("/v1/terminal/history",
          [&terminal_store](const httplib::Request&, httplib::Response& res) {
            json_ok(res, terminal_store.history());
          });

  svr.Delete("/v1/terminal/clear", [&terminal_store](const httplib::Request&, httplib::Response& res) {
    terminal_store.clear();
    json_ok(res, json{{"ok", true}});
  });

  svr.Post("/v1/terminal/runSnippet",
           [&terminal_store, &config, &profile_ctx, &projects](const httplib::Request& req,
                                                               httplib::Response& res) {
             try {
               json body = body_object(req);
               if (!body.contains("cwd") && body.contains("sessionId") &&
                   body["sessionId"].is_string()) {
                 const std::string sid = body["sessionId"].get<std::string>();
                 if (!sid.empty()) {
                   try {
                     body["cwd"] = projects.ensure_dir(sid, "");
                   } catch (...) {
                     /* fall back to default cwd in TerminalStore */
                   }
                 }
               }
               json_ok(res, terminal_store.run_snippet(config, profile_ctx, body));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Post("/v1/terminal/saveSnippet",
           [&terminal_store, &profile_ctx](const httplib::Request& req, httplib::Response& res) {
             try {
               const json body = body_object(req);
               const std::string content = body.value("content", "");
               const std::string name = body.value("suggestedName", body.value("name", "snippet.txt"));
               json_ok(res, terminal_store.save_snippet(profile_ctx, content, name));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Post("/v1/terminal/line", [&terminal_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = body_object(req);
      const std::string kind = body.value("kind", "info");
      const std::string text = body.value("text", "");
      json_ok(res, terminal_store.append_line(kind, text));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/editor/read", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string path =
          arg_string(args, 0, body_object(req).value("path", body_object(req).value("filePath", "")));
      if (path.empty()) throw std::runtime_error("path required");
      json_ok(res, EditorService::read_file(path));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/editor/write", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      const std::string path = arg_string(args, 0, body.value("path", body.value("filePath", "")));
      const std::string content = arg_string(args, 1, body.value("content", ""));
      if (path.empty()) throw std::runtime_error("path required");
      EditorService::write_file(path, content);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/editor/openFiles", [](const httplib::Request& req, httplib::Response& res) {
    try {
      json_ok(res, EditorService::open_files(body_object(req)));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/editor/saveAs", [&profile_ctx](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = body_object(req);
      std::string path = body.value("path", body.value("filePath", ""));
      if (path.empty() && body.contains("suggestedPath") && body["suggestedPath"].is_string()) {
        path = body["suggestedPath"].get<std::string>();
      }
      if (!path.empty()) {
        const fs::path p(path);
        if (p.is_relative() && p.parent_path().empty()) {
          path = (fs::path(profile_ctx.profile_home()) / "workspace" / "snippets" /
                  p.filename())
                     .string();
          body["path"] = path;
        }
      }
      json_ok(res, EditorService::save_as(body));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/editor/deleteFile", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string path =
          arg_string(args, 0, body_object(req).value("path", body_object(req).value("filePath", "")));
      if (path.empty()) throw std::runtime_error("path required");
      EditorService::delete_file(path);
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/context/find", [&events](const httplib::Request&, httplib::Response& res) {
    events.publish("omega:context:find", json::object());
    json_ok(res, json{{"ok", true}});
  });

  svr.Post("/v1/context/gotoLine", [&events](const httplib::Request&, httplib::Response& res) {
    events.publish("omega:context:gotoLine", json::object());
    json_ok(res, json{{"ok", true}});
  });

  svr.Get("/v1/usage/summary", [&usage](const httplib::Request& req, httplib::Response& res) {
    try {
      std::string session_id = req.get_param_value("sessionId");
      if (session_id.empty()) session_id = req.get_param_value("session_id");
      if (session_id.empty()) {
        json_ok(res, usage.summary(std::nullopt));
      } else {
        json_ok(res, usage.summary(session_id));
      }
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/integrations/get", [&integrations](const httplib::Request&, httplib::Response& res) {
    json_ok(res, integrations.load());
  });

  svr.Post("/v1/integrations/set", [&integrations](const httplib::Request& req, httplib::Response& res) {
    try {
      json_ok(res, integrations.save(body_object(req)));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/assistant/defaultPrompt", [](const httplib::Request&, httplib::Response& res) {
    json_ok(res, default_assistant_prompt());
  });

  svr.Get("/v1/self-improve/list", [&self_improve](const httplib::Request&, httplib::Response& res) {
    json_ok(res, self_improve.list());
  });

  svr.Post("/v1/self-improve/reflect",
           [&self_improve](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string session_id = id_from_ipc_body(req);
               if (session_id.empty()) throw std::runtime_error("sessionId required");
               json_ok(res, self_improve.reflect(session_id));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Post("/v1/self-improve/janitor",
           [&self_improve](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string session_id = id_from_ipc_body(req);
               if (session_id.empty()) throw std::runtime_error("sessionId required");
               json_ok(res, self_improve.janitor_session(session_id));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Get("/v1/workforce/agents", [&workforce_store](const httplib::Request&, httplib::Response& res) {
    json_ok(res, workforce_store.list_agents());
  });

  svr.Get("/v1/workforce/runs", [&workforce_store](const httplib::Request&, httplib::Response& res) {
    json_ok(res, workforce_store.list_runs());
  });

  svr.Post("/v1/workforce/delegate", [&workforce](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      const std::string agent_id = arg_string(args, 0, body.value("agentId", ""));
      const std::string task = arg_string(args, 1, body.value("task", ""));
      if (agent_id.empty() || task.empty()) throw std::runtime_error("agentId and task required");
      json_ok(res, workforce.delegate_task(agent_id, task));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/workforce/moa", [&workforce](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string task = arg_string(args, 0, body_object(req).value("task", ""));
      if (task.empty()) throw std::runtime_error("task required");
      json_ok(res, workforce.run_moa(task));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/workforce/parallel", [&workforce](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = body_object(req);
      json tasks = body.contains("tasks") ? body["tasks"] : args_from_body(req);
      json_ok(res, workforce.run_parallel(tasks));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/workforce/standup", [&workforce](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const bool active = args.size() > 0 && args[0].is_boolean()
                              ? args[0].get<bool>()
                              : body_object(req).value("active", false);
      json_ok(res, workforce.toggle_standup(active));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/office/snapshot", [&workforce_store](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, workforce_store.snapshot());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/changed", [&workforce_store](const httplib::Request&, httplib::Response& res) {
    workforce_store.notify_changed();
    json_ok(res, json{{"ok", true}});
  });

  svr.Post("/v1/office/addMonitor", [&workforce_store](const httplib::Request& req, httplib::Response& res) {
    try {
      json_ok(res, workforce_store.add_monitor(body_object(req)));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/refreshMonitor",
           [&workforce_store](const httplib::Request& req, httplib::Response& res) {
             try {
               const std::string id = id_from_ipc_body(req);
               if (id.empty()) throw std::runtime_error("monitorId required");
               json_ok(res, workforce_store.refresh_monitor(id));
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  svr.Post("/v1/office/fetchPr", [&github](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string url = arg_string(args_from_body(req), 0, body_object(req).value("url", ""));
      if (url.empty()) throw std::runtime_error("url required");
      json_ok(res, github.fetch_pr_from_url(url));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/prComment", [&github](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      github.post_comment(arg_string(args, 0, body.value("owner", "")),
                          arg_string(args, 1, body.value("repo", "")),
                          arg_int(args, 2, body.value("number", 0)),
                          arg_string(args, 3, body.value("body", "")));
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/prReview", [&github](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      github.post_review(arg_string(args, 0, body.value("owner", "")),
                         arg_string(args, 1, body.value("repo", "")),
                         arg_int(args, 2, body.value("number", 0)),
                         arg_string(args, 3, body.value("event", "COMMENT")),
                         arg_string(args, 4, body.value("body", "")));
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/jiraComment", [&jira](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      jira.post_comment(arg_string(args, 0, body.value("issueKey", "")),
                        arg_string(args, 1, body.value("text", body.value("body", ""))));
      json_ok(res, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/pollSet", [&workforce_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = body_object(req);
      const json args = args_from_body(req);
      const bool enabled = args.size() > 0 && args[0].is_boolean() ? args[0].get<bool>()
                                                                    : body.value("enabled", false);
      std::optional<int> interval;
      if (body.contains("intervalMs")) interval = body.value("intervalMs", 300000);
      else if (args.size() > 1 && args[1].is_number_integer()) interval = args[1].get<int>();
      workforce_store.set_poll_enabled(enabled, interval);
      json_ok(res, workforce_store.snapshot());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/pollRefreshAll", [&workforce_store](const httplib::Request&, httplib::Response& res) {
    json_ok(res, json{{"refreshed", workforce_store.refresh_all_monitors()}});
  });

  svr.Post("/v1/office/skillGym", [&workforce](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, workforce.run_skill_gym());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/janitor", [&workforce](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, workforce.run_office_janitor());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/kanbanPin", [&workforce_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      const std::string task_id = arg_string(args, 0, body.value("taskId", ""));
      const bool pinned = args.size() > 1 && args[1].is_boolean()
                              ? args[1].get<bool>()
                              : body.value("pinned", true);
      if (task_id.empty()) throw std::runtime_error("taskId required");
      workforce_store.pin_kanban_task(task_id, pinned);
      json_ok(res, workforce_store.snapshot());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Post("/v1/office/kanbanMonitor", [&workforce_store](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string task_id = id_from_ipc_body(req);
      if (task_id.empty()) throw std::runtime_error("taskId required");
      json_ok(res, workforce_store.add_monitor_from_kanban(task_id));
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  });

  svr.Get("/v1/office/visualization/status",
          [&office_viz](const httplib::Request&, httplib::Response& res) {
            json_ok(res, office_viz.status());
          });

  svr.Post("/v1/office/visualization/setup",
           [&office_viz](const httplib::Request&, httplib::Response& res) {
             json_ok(res, office_viz.setup());
           });

  svr.Post("/v1/office/visualization/start",
           [&office_viz](const httplib::Request&, httplib::Response& res) {
             try {
               json_ok(res, office_viz.start());
             } catch (const std::exception& e) {
               json_err(res, 500, e.what());
             }
           });

  auto stop_office_viz = [&office_viz](const httplib::Request&, httplib::Response& res) {
    try {
      json_ok(res, office_viz.stop());
    } catch (const std::exception& e) {
      json_err(res, 500, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/office/visualization/stop", stop_office_viz);

  svr.Get("/v1/media/state", [&media_player](const httplib::Request&, httplib::Response& res) {
    json_ok(res, media_player.state());
  });

  auto stop_media = [&media_player, &desktop_aux, &events](const httplib::Request&, httplib::Response& res) {
    desktop_aux.browser_media_command(json{{"action", "stop"}});
    json r = media_player.stop();
    desktop_aux.browser_hide(events);
    json_ok(res, r);
  };
  register_post_and_delete(svr, "/v1/media/stop", stop_media);

  svr.Post("/v1/media/pause", [&media_player, &desktop_aux](const httplib::Request&, httplib::Response& res) {
    json r = media_player.pause();
    desktop_aux.browser_media_command(json{{"action", "pause"}});
    json_ok(res, r);
  });

  svr.Post("/v1/media/resume", [&media_player, &desktop_aux](const httplib::Request&, httplib::Response& res) {
    json r = media_player.resume();
    desktop_aux.browser_media_command(json{{"action", "resume"}});
    json_ok(res, r);
  });

  svr.Post("/v1/media/showPreview", [&media_player](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = body_object(req);
      const json args = args_from_body(req);
      json payload = body;
      if (payload.empty() && args.is_array() && args.size() >= 2) {
        payload = json{{"sessionId", args[0]}, {"part", args[1]}};
      }
      json_ok(res, media_player.show_preview(payload));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  });

  svr.Post("/v1/media/reopenSessionVideo", [&sessions, &projects, &media_player](
                                               const httplib::Request& req, httplib::Response& res) {
    try {
      json body = body_object(req);
      const json args = args_from_body(req);
      if (args.is_array() && !args.empty()) {
        if (args[0].is_string()) body["sessionId"] = args[0].get<std::string>();
        if (args.size() > 1 && args[1].is_string()) body["jobId"] = args[1].get<std::string>();
      }
      json_ok(res, reopen_session_video(sessions, projects, media_player, body));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  register_event_channel_route(svr, "/v1/events/updater/status-event", "omega:updater:status-event");

  svr.Get("/v1/updater/status", [&updater](const httplib::Request&, httplib::Response& res) {
    json_ok(res, updater.status());
  });

  svr.Post("/v1/updater/check", [&updater](const httplib::Request&, httplib::Response& res) {
    json_ok(res, updater.check());
  });

  svr.Post("/v1/updater/install", [&updater](const httplib::Request&, httplib::Response& res) {
    json_ok(res, updater.install());
  });

  svr.Post("/v1/updater/status-event", [&updater](const httplib::Request&, httplib::Response& res) {
    json_ok(res, updater.status());
  });

  svr.Get("/v1/models/load-progress",
          [&model_load_progress](const httplib::Request&, httplib::Response& res) {
            json_ok(res, model_load_progress.snapshot());
          });

  svr.Post("/v1/models/download", [&model_download](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      const std::string repo = arg_string(args, 0, body.value("repo", ""));
      const std::string filename = arg_string(args, 1, body.value("filename", ""));
      json_ok(res, model_download.download(repo, filename));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Post("/v1/models/download-required",
           [&model_download](const httplib::Request& req, httplib::Response& res) {
             try {
               json body = parse_body(req);
               if (body.is_array() && !body.empty()) body = body[0];
               json_ok(res, model_download.download_required(body));
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  auto cancel_model_download = [&model_download](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      std::string repo = req.get_param_value("repo");
      std::string filename = req.get_param_value("filename");
      if (repo.empty()) repo = arg_string(args, 0, body.value("repo", ""));
      if (filename.empty()) filename = arg_string(args, 1, body.value("filename", ""));
      json_ok(res, model_download.cancel(repo, filename));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/models/download/cancel", cancel_model_download);

  svr.Post("/v1/models/download-adapter",
           [&model_download](const httplib::Request& req, httplib::Response& res) {
             try {
               const json args = args_from_body(req);
               const json body = body_object(req);
               const std::string repo = arg_string(args, 0, body.value("repo", ""));
               const std::string filename = arg_string(args, 1, body.value("filename", ""));
               json_ok(res, model_download.download_adapter(repo, filename));
             } catch (const std::exception& e) {
               json_err(res, 503, e.what());
             }
           });

  svr.Post("/v1/models/quantize", [&model_quantize](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = parse_body(req);
      if (body.is_array() && !body.empty()) body = body[0];
      json_ok(res, model_quantize.quantize(body));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  svr.Get("/v1/engines/sidecar/status", [&sidecar](const httplib::Request&, httplib::Response& res) {
    json_ok(res, sidecar.status());
  });

  svr.Post("/v1/engines/sidecar/install", [&sidecar, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = parse_body(req);
      json_ok(res, sidecar.install(body, events));
    } catch (const std::exception& e) {
      json_err(res, 503, e.what());
    }
  });

  auto uninstall_sidecar = [&sidecar](const httplib::Request&, httplib::Response& res) {
    json_ok(res, sidecar.uninstall());
  };
  register_post_and_delete(svr, "/v1/engines/sidecar/uninstall", uninstall_sidecar);

  register_event_channel_route(svr, "/v1/events/config/changed", "omega:config:changed");
  register_event_channel_route(svr, "/v1/events/cron/changed", "omega:cron:changed");
  register_event_channel_route(svr, "/v1/events/kanban/changed", "omega:kanban:changed");
  register_event_channel_route(svr, "/v1/events/providers/changed", "omega:providers:changed");
  register_event_channel_route(svr, "/v1/events/download/progress", "omega:download:progress");
  register_event_channel_route(svr, "/v1/events/quantize/progress", "omega:quantize:progress");
  register_event_channel_route(svr, "/v1/events/models/load-progress", "omega:models:load-progress");
  register_event_channel_route(svr, "/v1/events/models/inventoryChanged", "omega:models:inventoryChanged");
  register_event_channel_route(svr, "/v1/events/tool/approve/req", "omega:tool:approve:req");
  register_event_channel_route(svr, "/v1/events/capability/permission/req",
                               "omega:capability:permission:req");
  register_event_channel_route(svr, "/v1/events/stream/token", "omega:stream:token");
  register_event_channel_route(svr, "/v1/events/stream/metrics", "omega:stream:metrics");
  register_event_channel_route(svr, "/v1/events/stream/media", "omega:stream:media");
  register_event_channel_route(svr, "/v1/events/stream/done", "omega:stream:done");
  register_event_channel_route(svr, "/v1/events/stream/error", "omega:stream:error");
  register_event_channel_route(svr, "/v1/events/pipeline/activity/changed",
                               "omega:pipeline:activity:changed");
  register_event_channel_route(svr, "/v1/events/runtime/status-changed", "omega:runtime:status-changed");
  register_event_channel_route(svr, "/v1/events/engines/ollama/pullProgress",
                               "omega:engines:ollama:pullProgress");
  register_event_channel_route(svr, "/v1/events/engines/sidecar/installProgress",
                               "omega:engines:sidecar:installProgress");
  register_event_channel_route(svr, "/v1/events/finetune/progress", "omega:finetune:progress");
  register_event_channel_route(svr, "/v1/events/content-studio/changed", "omega:content-studio:changed");
  register_event_channel_route(svr, "/v1/events/content-studio/webhook", "omega:content-studio:webhook");
  register_event_channel_route(svr, "/v1/events/content-studio/setupProgress",
                               "omega:content-studio:setupProgress");
  register_event_channel_route(svr, "/v1/models/inventoryChanged", "omega:models:inventoryChanged");

  svr.Get("/v1/routerModels/status", [&router_models](const httplib::Request&, httplib::Response& res) {
    json_ok(res, router_models.status());
  });
  svr.Post("/v1/routerModels/installNodeRuntime", [&router_models, &events](const httplib::Request&, httplib::Response& res) {
    try { json_ok(res, router_models.install_node_runtime(events)); } catch (const std::exception& e) { json_err(res, 503, e.what()); }
  });
  svr.Post("/v1/routerModels/setupPython", [&router_models, &events](const httplib::Request&, httplib::Response& res) {
    try { json_ok(res, router_models.setup_python(events)); } catch (const std::exception& e) { json_err(res, 503, e.what()); }
  });
  svr.Post("/v1/routerModels/build", [&router_models, &events](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const std::string role = arg_string(args, 0, body_object(req).value("role", "embedding"));
      json_ok(res, router_models.build(role, events));
    } catch (const std::exception& e) { json_err(res, 503, e.what()); }
  });
  auto remove_router_model = [&router_models](const httplib::Request& req, httplib::Response& res) {
    try {
      const json args = args_from_body(req);
      const json body = body_object(req);
      std::string role = id_from_ipc_request(req);
      if (role.empty()) role = arg_string(args, 0, body.value("role", "embedding"));
      json_ok(res, router_models.remove(role));
    } catch (const std::exception& e) {
      json_err(res, 400, e.what());
    }
  };
  register_post_and_delete(svr, "/v1/routerModels/remove", remove_router_model);
  register_event_channel_route(svr, "/v1/events/routerModels/buildProgress", "omega:routerModels:buildProgress");

  svr.Get("/v1/browser/status", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_status()); });
  svr.Get("/v1/browser/getStatus", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_status()); });
  svr.Get("/v1/browser/info", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_status()); });
  svr.Post("/v1/browser/show", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) {
    try { json_ok(res, desktop_aux.browser_show(body_object(req), events)); } catch (const std::exception& e) { json_err(res, 501, e.what()); }
  });
  svr.Post("/v1/browser/hide", [&desktop_aux, &events](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_hide(events)); });
  svr.Post("/v1/browser/hidden", [&desktop_aux, &events](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_hide(events)); });
  svr.Post("/v1/browser/navigate", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) {
    try { json_ok(res, desktop_aux.browser_navigate(arg_string(args_from_body(req), 0, body_object(req).value("url", "")), events)); } catch (const std::exception& e) { json_err(res, 400, e.what()); }
  });
  svr.Post("/v1/browser/back", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_back()); });
  svr.Post("/v1/browser/forward", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_forward()); });
  svr.Post("/v1/browser/reload", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.browser_reload()); });
  svr.Post("/v1/browser/mediaCommand", [&desktop_aux](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.browser_media_command(body_object(req))); });
  svr.Post("/v1/browser/setBounds", [&desktop_aux](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.browser_set_bounds(body_object(req))); });
  register_event_channel_route(svr, "/v1/events/browser/hidden", "omega:browser:hidden");

  svr.Get("/v1/companion/get-active-chat", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.companion_get_active_chat()); });
  svr.Post("/v1/companion/set-active-chat", [&desktop_aux](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.companion_set_active_chat(body_object(req))); });
  svr.Post("/v1/companion/send-to-main", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.companion_send_to_main(body_object(req), events)); });
  svr.Post("/v1/companion/reply-broadcast", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.companion_reply_broadcast(body_object(req), events)); });
  register_event_channel_route(svr, "/v1/events/companion/send-deliver", "omega:companion:send-deliver");
  register_event_channel_route(svr, "/v1/events/companion/reply-deliver", "omega:companion:reply-deliver");

  svr.Get("/v1/avatar-monitor/get-enabled", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.avatar_get_enabled()); });
  svr.Post("/v1/avatar-monitor/set-enabled", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.avatar_set_enabled(body_object(req), events)); });
  svr.Post("/v1/avatar-monitor/signals", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.avatar_signals(body_object(req), events)); });
  svr.Post("/v1/avatar-monitor/sync-layout", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.avatar_sync_layout(body_object(req), events)); });
  svr.Post("/v1/avatar-monitor/set-overlay-visible", [&desktop_aux](const httplib::Request& req, httplib::Response& res) {
    json_ok(res, desktop_aux.avatar_set_overlay_visible(body_object(req)));
  });
  svr.Post("/v1/avatar-monitor/restore-main", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.avatar_restore_main()); });
  register_event_channel_route(svr, "/v1/avatar-monitor/enabled", "omega:avatar-monitor:enabled");
  register_event_channel_route(svr, "/v1/avatar-monitor/layout", "omega:avatar-monitor:layout");
  register_event_channel_route(svr, "/v1/events/avatar-monitor/enabled", "omega:avatar-monitor:enabled");
  register_event_channel_route(svr, "/v1/events/avatar-monitor/layout", "omega:avatar-monitor:layout");
  register_event_channel_route(svr, "/v1/events/avatar-monitor/signals", "omega:avatar-monitor:signals");

  svr.Post("/v1/screen-snip/init", [&desktop_aux, &events](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.screen_snip_init(events)); });
  svr.Get("/v1/screen-snip/get-bounds", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.screen_snip_get_bounds()); });
  svr.Post("/v1/screen-snip/capture", [&desktop_aux](const httplib::Request&, httplib::Response& res) { json_ok(res, desktop_aux.screen_snip_capture()); });
  svr.Post("/v1/screen-snip/submit", [&desktop_aux](const httplib::Request& req, httplib::Response& res) {
    try { json_ok(res, desktop_aux.screen_snip_submit(body_object(req))); } catch (const std::exception& e) { json_err(res, 501, e.what()); }
  });
  auto cancel_screen_snip = [&desktop_aux](const httplib::Request&, httplib::Response& res) {
    json_ok(res, desktop_aux.screen_snip_cancel());
  };
  register_post_and_delete(svr, "/v1/screen-snip/cancel", cancel_screen_snip);
  svr.Post("/v1/screen-snip/save", [&desktop_aux](const httplib::Request& req, httplib::Response& res) {
    try { json_ok(res, desktop_aux.screen_snip_save(body_object(req))); } catch (const std::exception& e) { json_err(res, 501, e.what()); }
  });
  register_event_channel_route(svr, "/v1/events/screen-snip/init", "omega:screen-snip:init");

  svr.Post("/v1/voice/speak", [&desktop_aux, &events](const httplib::Request& req, httplib::Response& res) { json_ok(res, desktop_aux.voice_speak(body_object(req), events)); });
  register_event_channel_route(svr, "/v1/events/voice/speak", "omega:voice:speak");

  register_event_channel_route(svr, "/v1/session/messageAppended", "omega:session:messageAppended");
  register_event_channel_route(svr, "/v1/session/assistantPatch", "omega:session:assistantPatch");
  register_event_channel_route(svr, "/v1/events/session/messageAppended", "omega:session:messageAppended");
  register_event_channel_route(svr, "/v1/events/session/assistantPatch", "omega:session:assistantPatch");
  register_event_channel_route(svr, "/v1/events/agent/step", "omega:agent:step");
  register_event_channel_route(svr, "/v1/events/agent/token", "omega:agent:token");
  register_event_channel_route(svr, "/v1/events/debug/event", "omega:debug:event");
  register_event_channel_route(svr, "/v1/events/workflows/event", "omega:workflows:event");
}

}  // namespace omega::runtime
