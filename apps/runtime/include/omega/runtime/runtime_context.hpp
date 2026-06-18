#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/native_routes.hpp"
#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/route_catalog.hpp"
#include "omega/runtime/server_options.hpp"
#include "omega/runtime/storage/cron_store.hpp"
#include "omega/runtime/storage/database.hpp"
#include "omega/runtime/storage/kanban_store.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/profile_store.hpp"
#include "omega/runtime/storage/rag_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/storage/skills_store.hpp"
#include "omega/runtime/storage/soul_store.hpp"
#include "omega/runtime/storage/workflow_store.hpp"
#include "omega/runtime/chat/agent_service.hpp"
#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/chat/stream_hub.hpp"
#include "omega/runtime/cron_scheduler.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/storage/input_pipeline_store.hpp"
#include "omega/runtime/storage/mcp_store.hpp"
#include "omega/runtime/storage/gateway_store.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/finetune_store.hpp"
#include "omega/runtime/finetune/finetune_runner.hpp"
#include "omega/runtime/storage/plugin_store.hpp"
#include "omega/runtime/storage/provider_store.hpp"
#include "omega/runtime/services/mcp_client_manager.hpp"
#include "omega/runtime/services/gateway_manager.hpp"
#include "omega/runtime/services/pipeline_activity.hpp"
#include "omega/runtime/services/debug_store.hpp"
#include "omega/runtime/services/content_job_delivery_service.hpp"
#include "omega/runtime/services/content_studio_orchestrator.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/storage/model_config_store.hpp"
#include "omega/runtime/finetune/finetune_dataset_service.hpp"
#include "omega/runtime/models/model_meta_service.hpp"
#include "omega/runtime/models/hf_client.hpp"
#include "omega/runtime/models/gpu_probe.hpp"
#include "omega/runtime/models/model_presets.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/services/terminal_store.hpp"
#include "omega/runtime/storage/integrations_store.hpp"
#include "omega/runtime/storage/usage_store.hpp"
#include "omega/runtime/services/self_improve_service.hpp"
#include "omega/runtime/services/chat_attachment_service.hpp"
#include "omega/runtime/services/integrations_api.hpp"
#include "omega/runtime/services/workforce_store.hpp"
#include "omega/runtime/services/workforce_orchestrator.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/services/updater_service.hpp"
#include "omega/runtime/services/office_visualization_service.hpp"
#include "omega/runtime/models/model_download_service.hpp"
#include "omega/runtime/models/model_quantize_service.hpp"
#include "omega/runtime/models/model_load_progress.hpp"
#include "omega/runtime/services/sidecar_service.hpp"
#include "omega/runtime/services/router_models_service.hpp"
#include "omega/runtime/services/desktop_aux_service.hpp"
#include "omega/runtime/python/python_supervisor.hpp"
#include "omega/runtime/tools/agent_platform_tools.hpp"
#include "omega/runtime/tools/agent_desktop_tools.hpp"
#include "omega/runtime/tools/tool_registry.hpp"
#include "omega/runtime/workflows/workflow_runner.hpp"

#include <nlohmann/json.hpp>

#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace httplib {
class Server;
}

namespace omega::runtime {

class RuntimeContext {
 public:
  explicit RuntimeContext(ServerOptions options);
  ~RuntimeContext();

  void register_routes(httplib::Server& svr);
  nlohmann::json runtime_info() const;

  ConfigStore& config() { return config_; }
  EngineClient& engine() { return engine_; }
  Database& database() { return database_; }
  SessionStore& sessions() { return sessions_; }
  MemoryStore& memory() { return memory_; }
  RagStore& rag() { return rag_; }
  WorkflowStore& workflows() { return workflows_; }
  ProfileContext& profile() { return profile_; }
  ToolRegistry& tools() { return tools_; }
  EventBus& events() { return events_; }
  WorkflowRunner& workflows_runner() { return workflow_runner_; }
  ChatService& chat() { return chat_; }

  void start_background_services();
  void stop_background_services();
  AgentService& agent() { return agent_; }
  const RouteCatalog& catalog() const { return catalog_; }

  /** True when route is implemented in C++ (no Electron fallback). */
  bool is_native_route(const std::string& method, const std::string& path) const {
    return is_native_http_route(method, path);
  }

  /** Aggregated host, runtime, engine, GPU, and subsystem diagnostics. */
  nlohmann::json system_info_snapshot();

 private:
  nlohmann::json runtime_model_status_snapshot();
  /** Shared by HTTP ``POST /v1/models/load`` and post–Content Studio chat reload. */
  nlohmann::json load_model_sync(const std::string& model_id,
                                 const nlohmann::json& body = nlohmann::json::object());
  /** After Content Studio — restart engine and reload chat model (runs on finalize thread, not HTTP). */
  void reload_chat_model_after_content_studio(const std::string& model_id,
                                              const std::string& job_id);
  void apply_engine_event_to_model_cache(const std::string& event,
                                         const nlohmann::json& payload);
  void handle_engine_failure(const std::string& reason);
  void publish_runtime_model_status(const std::string& reason,
                                    const nlohmann::json& extra = nlohmann::json::object(),
                                    bool query_engine = true);
  /** Create ~/.omega/content-studio dirs, run migrations, mark CS ready (on-demand mode). */
  void try_bootstrap_content_studio(const char* reason);

  ServerOptions options_;
  ConfigStore config_;
  EngineClient engine_;
  Database database_;
  SessionStore sessions_;
  MemoryStore memory_;
  RagStore rag_;
  WorkflowStore workflows_;
  ProfileContext profile_;
  ProfileStore profile_store_;
  ProviderStore providers_;
  InputPipelineStore input_pipelines_;
  PluginStore plugins_;
  McpStore mcp_;
  GatewayStore gateway_store_;
  ProjectStore project_store_;
  FinetuneStore finetune_store_;
  FinetuneRunner finetune_runner_;
  FinetuneDatasetService finetune_datasets_;
  PipelineActivityService pipeline_activity_;
  PythonSupervisor python_;
  ContentStudioSettings content_studio_settings_;
  ContentStudioSupervisor content_studio_;
  ContentJobDeliveryService content_job_delivery_;
  ContentStudioOrchestrator content_orchestrator_;
  AgentDesktopTools agent_desktop_;
  AgentPlatformTools agent_platform_;
  ModelConfigStore model_config_;
  ModelMetaService model_meta_;
  HfClient hf_client_;
  EventBus events_;
  DebugStore debug_store_;
  InferenceRouter inference_;
  TerminalStore terminal_store_;
  IntegrationsStore integrations_;
  UsageStore usage_;
  SelfImproveService self_improve_;
  ChatAttachmentService chat_attachments_;
  GitHubClient github_client_;
  JiraClient jira_client_;
  MediaPlayerService media_player_;
  UpdaterService updater_;
  OfficeVisualizationService office_viz_;
  ModelDownloadService model_download_;
  ModelQuantizeService model_quantize_;
  ModelLoadProgress model_load_progress_;
  SidecarService sidecar_;
  RouterModelsService router_models_;
  DesktopAuxService desktop_aux_;
  McpClientManager mcp_clients_;
  SkillsStore skills_;
  SoulStore soul_;
  CronStore cron_;
  KanbanStore kanban_;
  ToolRegistry tools_;
  StreamHub streams_;
  AgentService agent_;
  WorkforceStore workforce_store_;
  WorkforceOrchestrator workforce_;
  WorkflowRunner workflow_runner_;
  ChatService chat_;
  GatewayManager gateway_;
  CronScheduler cron_scheduler_;
  RouteCatalog catalog_;
  std::string catalog_path_;
  mutable std::mutex model_status_mu_;
  /** Serializes engine start/stop/load (HTTP + post–Content Studio reload). */
  std::recursive_mutex engine_load_mu_;
  nlohmann::json cached_model_status_{
      {"state", "ready"}, {"activeModel", ""}, {"loadedModels", nlohmann::json::array()}, {"nativeLoaded", ""}};
};

}  // namespace omega::runtime
