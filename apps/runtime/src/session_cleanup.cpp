#include "omega/runtime/session_cleanup.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/services/content_job_delivery_service.hpp"
#include "omega/runtime/services/content_studio_orchestrator.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/storage/usage_store.hpp"

#include <filesystem>
#include <unordered_set>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::unordered_set<std::string> collect_content_studio_project_ids(const json& messages) {
  std::unordered_set<std::string> out;
  if (!messages.is_array()) return out;
  for (const auto& m : messages) {
    if (m.value("role", "") != "assistant") continue;
    const json parts = m.value("parts", json::array());
    if (!parts.is_array()) continue;
    for (const auto& p : parts) {
      if (p.value("type", "") != "content_studio") continue;
      const std::string pid = p.value("projectId", p.value("project_id", ""));
      if (!pid.empty()) out.insert(pid);
    }
  }
  return out;
}

void remove_content_studio_project(ContentStudioSupervisor* content_studio,
                                    const std::string& project_id) {
  if (project_id.empty()) return;
  if (project_id.find("..") != std::string::npos || project_id.find('/') != std::string::npos ||
      project_id.find('\\') != std::string::npos) {
    return;
  }
  if (content_studio) {
    try {
      content_studio->api("DELETE", "/api/agent/v1/projects/" + project_id);
    } catch (...) {
    }
  }
  std::error_code ec;
  fs::remove_all(fs::path(resolve_content_studio_storage()) / project_id, ec);
}

}  // namespace

json delete_session_with_cleanup(const std::string& session_id, const SessionCleanupDeps& deps) {
  if (session_id.empty()) throw std::runtime_error("session id required");

  json messages = deps.sessions.get_messages(session_id);
  const auto project_ids = collect_content_studio_project_ids(messages);

  if (deps.delivery) deps.delivery->purge_session(session_id);
  if (deps.content_orchestrator) deps.content_orchestrator->discard_session(session_id);

  json removed_cs = json::array();
  for (const std::string& pid : project_ids) {
    remove_content_studio_project(deps.content_studio, pid);
    removed_cs.push_back(pid);
  }

  bool project_dir_removed = false;
  if (deps.projects) {
    project_dir_removed = deps.projects->remove_session_project(session_id);
  }

  int usage_rows_removed = 0;
  if (deps.usage) {
    usage_rows_removed = deps.usage->remove_session_records(session_id);
  }

  if (deps.media) deps.media->stop_if_session(session_id);

  deps.sessions.delete_session(session_id);

  return json{{"deleted", true},
              {"sessionId", session_id},
              {"cleanup",
               json{{"projectDirRemoved", project_dir_removed},
                    {"contentStudioProjects", removed_cs},
                    {"usageRowsRemoved", usage_rows_removed}}}};
}

}  // namespace omega::runtime
