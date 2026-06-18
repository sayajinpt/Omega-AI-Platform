#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/services/integrations_api.hpp"
#include "omega/runtime/storage/kanban_store.hpp"

#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class WorkforceStore {
 public:
  WorkforceStore(ProfileContext& profile, ConfigStore& config, KanbanStore& kanban,
                 GitHubClient& github, JiraClient& jira, EventBus& events);

  nlohmann::json list_agents();
  nlohmann::json list_runs(int limit = 50);
  nlohmann::json snapshot();
  void notify_changed();

  nlohmann::json create_run(const nlohmann::json& partial);
  nlohmann::json upsert_run(const nlohmann::json& run);
  void set_agent_activity(const std::string& agent_id, const nlohmann::json& activity);

  void set_standup_active(bool active);
  void set_skill_gym_active(bool active);
  void set_janitor_active(bool active);
  void set_poll_enabled(bool enabled, std::optional<int> interval_ms);

  nlohmann::json add_monitor(const nlohmann::json& body);
  nlohmann::json refresh_monitor(const std::string& monitor_id);
  int refresh_all_monitors();

  void pin_kanban_task(const std::string& task_id, bool pinned);
  nlohmann::json add_monitor_from_kanban(const std::string& task_id);

 private:
  nlohmann::json load_file();
  void save_file(const nlohmann::json& data);
  nlohmann::json default_agents();
  std::string summarize_monitor(const nlohmann::json& mon);
  nlohmann::json list_kanban_pins();

  ProfileContext& profile_;
  ConfigStore& config_;
  KanbanStore& kanban_;
  GitHubClient& github_;
  JiraClient& jira_;
  EventBus& events_;
  std::mutex mu_;
  nlohmann::json cached_;
  bool loaded_ = false;
};

}  // namespace omega::runtime
