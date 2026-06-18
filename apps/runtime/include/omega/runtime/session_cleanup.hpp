#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ContentJobDeliveryService;
class ContentStudioOrchestrator;
class ContentStudioSupervisor;
class MediaPlayerService;
class ProjectStore;
class SessionStore;
class UsageStore;

struct SessionCleanupDeps {
  SessionStore& sessions;
  ProjectStore* projects = nullptr;
  ContentJobDeliveryService* delivery = nullptr;
  ContentStudioOrchestrator* content_orchestrator = nullptr;
  ContentStudioSupervisor* content_studio = nullptr;
  UsageStore* usage = nullptr;
  MediaPlayerService* media = nullptr;
};

/** Remove on-disk artifacts for a chat, then delete the session row/messages. */
nlohmann::json delete_session_with_cleanup(const std::string& session_id,
                                           const SessionCleanupDeps& deps);

}  // namespace omega::runtime
