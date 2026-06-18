#pragma once

#include "omega/runtime/services/chat_tts_orchestrator.hpp"

#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class ContentJobDeliveryService;
class ContentStudioOrchestrator;
class ContentStudioSupervisor;
class ConfigStore;
class EngineClient;
class EventBus;
class FinetuneDatasetService;
class FinetuneRunner;
class FinetuneStore;
class MediaPlayerService;
class MemoryStore;
class ModelMetaService;
class PluginStore;
class ProjectStore;
class SessionStore;
class SkillsStore;
class WorkforceOrchestrator;

class UsageStore;

/** Native implementations for agent tools that use runtime services (not shell-only). */
class AgentPlatformTools {
 public:
  void attach(ConfigStore* config, EngineClient* engine, EventBus* events, SessionStore* sessions,
              PluginStore* plugins, SkillsStore* skills, MemoryStore* memory,
              FinetuneStore* finetune_store, FinetuneRunner* finetune_runner,
              FinetuneDatasetService* finetune_datasets, WorkforceOrchestrator* workforce,
              ModelMetaService* model_meta, ProjectStore* projects, MediaPlayerService* media,
              ContentJobDeliveryService* delivery = nullptr,
              ContentStudioOrchestrator* content_orchestrator = nullptr,
              ContentStudioSupervisor* content_studio = nullptr, UsageStore* usage = nullptr);

  bool handles(const std::string& name) const;
  nlohmann::json run(const std::string& name, const std::map<std::string, std::string>& args);
  std::optional<nlohmann::json> try_resume_tts_choice(const std::string& session_id,
                                                      const std::string& user_message);

 private:
  ConfigStore* config_{nullptr};
  EngineClient* engine_{nullptr};
  EventBus* events_{nullptr};
  SessionStore* sessions_{nullptr};
  PluginStore* plugins_{nullptr};
  SkillsStore* skills_{nullptr};
  MemoryStore* memory_{nullptr};
  FinetuneStore* finetune_store_{nullptr};
  FinetuneRunner* finetune_runner_{nullptr};
  FinetuneDatasetService* finetune_datasets_{nullptr};
  WorkforceOrchestrator* workforce_{nullptr};
  ModelMetaService* model_meta_{nullptr};
  ProjectStore* projects_{nullptr};
  MediaPlayerService* media_{nullptr};
  ContentJobDeliveryService* delivery_{nullptr};
  ContentStudioOrchestrator* content_orchestrator_{nullptr};
  ContentStudioSupervisor* content_studio_{nullptr};
  UsageStore* usage_{nullptr};
  ChatTtsOrchestrator tts_orchestrator_;
};

}  // namespace omega::runtime
