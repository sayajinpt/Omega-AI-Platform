#pragma once

#include <string>

struct httplib_Server;

namespace httplib {
class Server;
}

namespace omega::runtime {

class ConfigStore;
class CronStore;
class EngineClient;
class KanbanStore;
class MemoryStore;
class ProfileStore;
class RagStore;
class SessionStore;
class SkillsStore;
class SoulStore;
class AgentService;
class ChatService;
class EventBus;
class ToolRegistry;
class WorkflowStore;
class ProfileContext;
class ProviderStore;
class InputPipelineStore;
class PluginStore;
class McpStore;
class GatewayManager;
class McpClientManager;
class ProjectStore;
class PipelineActivityService;
class DebugStore;
class FinetuneStore;
class PythonSupervisor;
class ContentStudioSupervisor;
class ContentStudioOrchestrator;
class ContentStudioSettings;
class ContentJobDeliveryService;
class ModelConfigStore;
class FinetuneRunner;
class FinetuneDatasetService;
class ModelMetaService;
class HfClient;
class InferenceRouter;
class TerminalStore;
class IntegrationsStore;
class UsageStore;
class SelfImproveService;
class ChatAttachmentService;
class WorkforceStore;
class WorkforceOrchestrator;
class GitHubClient;
class JiraClient;
class MediaPlayerService;
class UpdaterService;
class OfficeVisualizationService;
class ModelDownloadService;
class ModelQuantizeService;
class ModelLoadProgress;
class SidecarService;
class RouterModelsService;
class DesktopAuxService;
class WorkflowRunner;

struct NativeRouteDeps {
  ConfigStore& config;
  SessionStore& sessions;
  MemoryStore& memory;
  RagStore& rag;
  WorkflowStore& workflows;
  ProfileContext& profile;
  ProfileStore& profiles;
  ProviderStore& providers;
  InputPipelineStore& input_pipelines;
  PluginStore& plugins;
  McpStore& mcp;
  McpClientManager& mcp_clients;
  GatewayManager& gateway;
  ProjectStore& projects;
  PipelineActivityService& pipeline_activity;
  DebugStore& debug_store;
  FinetuneStore& finetune;
  PythonSupervisor& python;
  ContentStudioSupervisor& content_studio;
  ContentStudioOrchestrator& content_orchestrator;
  ContentStudioSettings& content_studio_settings;
  ContentJobDeliveryService& content_job_delivery;
  ModelConfigStore& model_config;
  FinetuneRunner& finetune_runner;
  FinetuneDatasetService& finetune_datasets;
  ModelMetaService& model_meta;
  HfClient& hf_client;
  InferenceRouter& inference;
  TerminalStore& terminal_store;
  IntegrationsStore& integrations;
  UsageStore& usage;
  SelfImproveService& self_improve;
  ChatAttachmentService& chat_attachments;
  WorkforceStore& workforce_store;
  WorkforceOrchestrator& workforce;
  GitHubClient& github;
  JiraClient& jira;
  MediaPlayerService& media_player;
  UpdaterService& updater;
  OfficeVisualizationService& office_viz;
  ModelDownloadService& model_download;
  ModelQuantizeService& model_quantize;
  ModelLoadProgress& model_load_progress;
  SidecarService& sidecar;
  RouterModelsService& router_models;
  DesktopAuxService& desktop_aux;
  EngineClient& engine;
  SkillsStore& skills;
  SoulStore& soul;
  CronStore& cron;
  KanbanStore& kanban;
  ToolRegistry& tools;
  ChatService& chat;
  AgentService& agent;
  EventBus& events;
  WorkflowRunner& workflow_runner;
};

void register_native_routes(httplib::Server& svr, const NativeRouteDeps& deps);

/** Paths implemented in C++ (no Electron fallback). */
bool is_native_http_route(const std::string& method, const std::string& path);

}  // namespace omega::runtime
