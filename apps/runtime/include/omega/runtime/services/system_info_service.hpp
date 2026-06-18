#pragma once

#include <functional>
#include <nlohmann/json_fwd.hpp>

namespace omega::runtime {

class ContentStudioSupervisor;
class EngineClient;
class GatewayManager;
class McpClientManager;
class ModelLoadProgress;
class OfficeVisualizationService;
class PythonSupervisor;
class RouterModelsService;
class SidecarService;
class UpdaterService;

struct SystemInfoInputs {
  std::function<nlohmann::json()> runtime_info;
  std::function<nlohmann::json()> runtime_status;
  EngineClient& engine;
  PythonSupervisor& python;
  ContentStudioSupervisor& content_studio;
  SidecarService& sidecar;
  UpdaterService& updater;
  RouterModelsService& router_models;
  ModelLoadProgress& model_load_progress;
  McpClientManager& mcp_clients;
  GatewayManager& gateway;
  OfficeVisualizationService& office_viz;
};

nlohmann::json host_system_info();
nlohmann::json build_inference_backends(const nlohmann::json& engine_health,
                                        const nlohmann::json& gpu_devices);
nlohmann::json gather_system_info(const SystemInfoInputs& inputs);

}  // namespace omega::runtime
