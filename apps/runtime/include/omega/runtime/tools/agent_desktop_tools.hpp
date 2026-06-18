#pragma once

#include <map>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ConfigStore;
class DesktopAuxService;
class EngineClient;
class EventBus;
class MediaPlayerService;
class ToolRegistry;

/** Native implementations for agent tools previously in Electron main. */
class AgentDesktopTools {
 public:
  void attach(ConfigStore* config, EngineClient* engine, MediaPlayerService* media,
              DesktopAuxService* desktop_aux, EventBus* events, ToolRegistry* tools);

  bool handles(const std::string& name) const;
  nlohmann::json run(const std::string& name, const std::map<std::string, std::string>& args);

 private:
  ConfigStore* config_{nullptr};
  EngineClient* engine_{nullptr};
  MediaPlayerService* media_{nullptr};
  DesktopAuxService* desktop_aux_{nullptr};
  EventBus* events_{nullptr};
  ToolRegistry* tools_{nullptr};
};

}  // namespace omega::runtime
