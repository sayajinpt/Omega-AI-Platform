#include "omega/runtime/services/workforce_store.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <regex>
#include <unordered_map>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string workforce_path(ProfileContext& profile) {
  return (fs::path(profile.profile_home()) / "workforce.json").string();
}

}  // namespace

WorkforceStore::WorkforceStore(ProfileContext& profile, ConfigStore& config, KanbanStore& kanban,
                               GitHubClient& github, JiraClient& jira, EventBus& events)
    : profile_(profile),
      config_(config),
      kanban_(kanban),
      github_(github),
      jira_(jira),
      events_(events) {}

json WorkforceStore::default_agents() {
  const json cfg = config_.load();
  const std::string model = cfg.value("defaultModel", "default");
  return json::array({json{{"id", "planner"}, {"name", "Planner"}, {"role", "planner"},
                             {"modelId", model}, {"color", "#818cf8"}},
                        json{{"id", "executor"}, {"name", "Executor"}, {"role", "executor"},
                             {"modelId", model}, {"color", "#34d399"}},
                        json{{"id", "critic"}, {"name", "Critic"}, {"role", "critic"},
                             {"modelId", model}, {"color", "#fbbf24"}},
                        json{{"id", "researcher"}, {"name", "Researcher"}, {"role", "researcher"},
                             {"modelId", model}, {"color", "#38bdf8"}}});
}

json WorkforceStore::load_file() {
  std::lock_guard lock(mu_);
  if (loaded_) return cached_;
  const fs::path p = workforce_path(profile_);
  if (!fs::exists(p)) {
    cached_ = json{{"agents", default_agents()},
                   {"runs", json::array()},
                   {"monitors", json::array()},
                   {"standupActive", false},
                   {"pollEnabled", false},
                   {"pollIntervalMs", 300000},
                   {"activity", json::object()}};
    loaded_ = true;
    return cached_;
  }
  try {
    std::ifstream in(p);
    cached_ = json::parse(in);
    if (!cached_.contains("agents") || !cached_["agents"].is_array() ||
        cached_["agents"].empty()) {
      cached_["agents"] = default_agents();
    }
    if (!cached_.contains("runs")) cached_["runs"] = json::array();
    if (!cached_.contains("monitors")) cached_["monitors"] = json::array();
    if (!cached_.contains("activity")) cached_["activity"] = json::object();
    if (!cached_.contains("standupActive")) cached_["standupActive"] = false;
    if (!cached_.contains("pollEnabled")) cached_["pollEnabled"] = false;
    if (!cached_.contains("pollIntervalMs")) cached_["pollIntervalMs"] = 300000;
  } catch (...) {
    cached_ = json{{"agents", default_agents()},
                   {"runs", json::array()},
                   {"monitors", json::array()},
                   {"standupActive", false},
                   {"pollEnabled", false},
                   {"pollIntervalMs", 300000},
                   {"activity", json::object()}};
  }
  loaded_ = true;
  return cached_;
}

void WorkforceStore::save_file(const json& data) {
  std::lock_guard lock(mu_);
  cached_ = data;
  loaded_ = true;
  const fs::path p = workforce_path(profile_);
  fs::create_directories(p.parent_path());
  std::ofstream out(p);
  out << data.dump(2);
}

void WorkforceStore::notify_changed() {
  events_.publish("omega:office:changed", snapshot());
}

json WorkforceStore::list_agents() { return load_file()["agents"]; }

json WorkforceStore::list_runs(int limit) {
  json runs = load_file()["runs"];
  if (!runs.is_array()) return json::array();
  std::vector<json> sorted;
  for (const auto& r : runs) {
    if (r.is_object()) sorted.push_back(r);
  }
  std::sort(sorted.begin(), sorted.end(), [](const json& a, const json& b) {
    return a.value("updatedAt", 0LL) > b.value("updatedAt", 0LL);
  });
  json out = json::array();
  for (size_t i = 0; i < sorted.size() && static_cast<int>(i) < limit; ++i) out.push_back(sorted[i]);
  return out;
}

json WorkforceStore::upsert_run(const json& run) {
  json data = load_file();
  json runs = data["runs"];
  const std::string id = run.value("id", "");
  bool found = false;
  for (auto& r : runs) {
    if (r.value("id", "") == id) {
      r = run;
      found = true;
      break;
    }
  }
  if (!found) runs.push_back(run);
  data["runs"] = runs;
  save_file(data);
  return run;
}

json WorkforceStore::create_run(const json& partial) {
  const int64_t now = now_ms();
  json run{{"id", random_uuid()},
           {"mode", partial.value("mode", "single")},
           {"task", partial.value("task", "")},
           {"status", "queued"},
           {"agentIds", partial.value("agentIds", json::array())},
           {"createdAt", now},
           {"updatedAt", now}};
  if (partial.contains("parentRunId")) run["parentRunId"] = partial["parentRunId"];
  return upsert_run(run);
}

void WorkforceStore::set_agent_activity(const std::string& agent_id, const json& activity) {
  json data = load_file();
  data["activity"][agent_id] = activity;
  save_file(data);
}

std::string WorkforceStore::summarize_monitor(const json& mon) {
  if (mon.contains("pr") && mon["pr"].is_object()) {
    const json pr = mon["pr"];
    int adds = 0;
    int dels = 0;
    if (pr.contains("files") && pr["files"].is_array()) {
      for (const auto& f : pr["files"]) {
        adds += f.value("additions", 0);
        dels += f.value("deletions", 0);
      }
    }
    return pr.value("title", mon.value("summary", "")) + " (+" + std::to_string(adds) + " −" +
           std::to_string(dels) + ")";
  }
  if (mon.contains("jira") && mon["jira"].is_object()) {
    const json j = mon["jira"];
    return j.value("key", "") + ": " + j.value("summary", "") + " · " + j.value("status", "");
  }
  return mon.value("summary", "");
}

json WorkforceStore::list_kanban_pins() {
  json out = json::array();
  const json tasks = kanban_.list();
  if (!tasks.is_array()) return out;
  int count = 0;
  for (const auto& t : tasks) {
    if (!t.value("officePinned", false)) continue;
    out.push_back(json{{"taskId", t.value("id", "")},
                       {"title", t.value("title", "")},
                       {"status", t.value("status", "")},
                       {"priority", t.value("priority", "normal")}});
    if (++count >= 8) break;
  }
  return out;
}

json WorkforceStore::snapshot() {
  const json data = load_file();
  const int64_t now = now_ms();
  json active_runs = json::array();
  if (data["runs"].is_array()) {
    for (const auto& r : data["runs"]) {
      const std::string st = r.value("status", "");
      if (st == "running" || st == "queued") active_runs.push_back(r);
    }
  }

  static const std::unordered_map<std::string, std::pair<double, double>> k_zones{
      {"desk", {0.18, 0.58}},       {"conference", {0.5, 0.38}}, {"monitor", {0.82, 0.42}},
      {"gym", {0.22, 0.22}},        {"janitor", {0.88, 0.2}}};

  json workers = json::array();
  const json agents = data["agents"];
  if (agents.is_array()) {
    for (size_t i = 0; i < agents.size(); ++i) {
      const json& a = agents[i];
      const std::string agent_id = a.value("id", "");
      json run_match = json(nullptr);
      for (const auto& r : active_runs) {
        const json ids = r.value("agentIds", json::array());
        if (!ids.is_array()) continue;
        for (const auto& aid : ids) {
          if (aid.is_string() && aid.get<std::string>() == agent_id) {
            run_match = r;
            break;
          }
        }
        if (!run_match.is_null()) break;
      }

      std::string status = "idle";
      std::string zone = "desk";
      const bool standup = data.value("standupActive", false);
      const bool skill_gym = data.value("skillGymActive", false);
      const bool janitor = data.value("janitorActive", false);

      json act = json(nullptr);
      if (data.contains("activity") && data["activity"].is_object() &&
          data["activity"].contains(agent_id)) {
        act = data["activity"][agent_id];
      }
      const bool act_live =
          act.is_object() && (now - act.value("at", 0LL)) < 90000;

      if (standup) {
        status = "standup";
        zone = "conference";
      } else if (act_live && act.value("status", "") == "running") {
        status = act.value("stepKind", "") == "critic" ? "review" : "working";
        const std::string kind = act.value("stepKind", "execute");
        if (kind == "plan" || kind == "critic") zone = kind == "critic" ? "monitor" : "conference";
        else zone = "desk";
      } else if (run_match.is_object()) {
        status = "working";
        zone = run_match.value("mode", "") == "moa" ? "conference" : "desk";
      } else if (skill_gym && a.value("role", "") == "researcher") {
        zone = "gym";
        status = "working";
      } else if (janitor && agent_id == "executor") {
        zone = "janitor";
        status = "working";
      } else if (a.value("role", "") == "critic") {
        if (data.contains("monitors") && data["monitors"].is_array()) {
          for (const auto& m : data["monitors"]) {
            if (!m.is_object()) continue;
            const std::string kind = m.value("kind", "");
            if (kind == "pr" || kind == "jira") {
              zone = "monitor";
              status = "review";
              break;
            }
          }
        }
      }

      auto zit = k_zones.find(zone);
      double x = zit != k_zones.end() ? zit->second.first : 0.18;
      double y = zit != k_zones.end() ? zit->second.second : 0.58;
      x = std::min(0.92, x + (static_cast<int>(i) % 3) * 0.06);
      y = std::min(0.88, y + (static_cast<int>(i) % 2) * 0.05);

      const std::string run_task =
          run_match.is_object() ? run_match.value("task", "") : "";
      const std::string run_id = run_match.is_object() ? run_match.value("id", "") : "";
      workers.push_back(json{{"agentId", agent_id},
                             {"name", a.value("name", "")},
                             {"role", a.value("role", "")},
                             {"status", status},
                             {"zone", zone},
                             {"task", act_live ? act.value("title", "") : run_task},
                             {"runId", run_id},
                             {"activityTitle", act_live ? act.value("title", "") : ""},
                             {"activityKind", act_live ? act.value("stepKind", "") : ""},
                             {"x", x},
                             {"y", y},
                             {"targetX", x},
                             {"targetY", y}});
    }
  }

  json monitors = json::array();
  if (data.contains("monitors") && data["monitors"].is_array()) monitors = data["monitors"];

  return json{{"workers", workers},
              {"monitors", monitors},
              {"standupActive", data.value("standupActive", false)},
              {"skillGymActive", data.value("skillGymActive", false)},
              {"janitorActive", data.value("janitorActive", false)},
              {"poll", json{{"enabled", data.value("pollEnabled", false)},
                            {"intervalMs", data.value("pollIntervalMs", 300000)},
                            {"lastPollAt", data.value("lastPollAt", json(nullptr))}}},
              {"kanbanPins", list_kanban_pins()},
              {"updatedAt", now}};
}

void WorkforceStore::set_standup_active(bool active) {
  json data = load_file();
  data["standupActive"] = active;
  save_file(data);
  notify_changed();
}

void WorkforceStore::set_skill_gym_active(bool active) {
  json data = load_file();
  data["skillGymActive"] = active;
  save_file(data);
  notify_changed();
}

void WorkforceStore::set_janitor_active(bool active) {
  json data = load_file();
  data["janitorActive"] = active;
  save_file(data);
  notify_changed();
}

void WorkforceStore::set_poll_enabled(bool enabled, std::optional<int> interval_ms) {
  json data = load_file();
  data["pollEnabled"] = enabled;
  if (interval_ms) data["pollIntervalMs"] = std::max(60000, *interval_ms);
  save_file(data);
  notify_changed();
}

json WorkforceStore::add_monitor(const json& body) {
  json data = load_file();
  json mon = body;
  mon["id"] = random_uuid();
  if (mon.value("kind", "") == "pr" && mon.contains("url") && mon["url"].is_string() &&
      !mon.contains("pr")) {
    try {
      mon["pr"] = github_.fetch_pr_from_url(mon["url"].get<std::string>());
    } catch (...) {
    }
  }
  if (mon.value("kind", "") == "jira" && !mon.contains("jira")) {
    const std::string input =
        mon.contains("url") && mon["url"].is_string() ? mon["url"].get<std::string>()
                                                      : mon.value("summary", "");
    try {
      mon["jira"] = jira_.fetch_from_url_or_key(input);
      if (mon["jira"].contains("url")) mon["url"] = mon["jira"]["url"];
    } catch (...) {
    }
  }
  mon["summary"] = summarize_monitor(mon);
  json monitors = json::array({mon});
  if (data["monitors"].is_array()) {
    for (const auto& m : data["monitors"]) {
      if (monitors.size() >= 12) break;
      monitors.push_back(m);
    }
  }
  data["monitors"] = monitors;
  save_file(data);
  notify_changed();
  return mon;
}

json WorkforceStore::refresh_monitor(const std::string& monitor_id) {
  json data = load_file();
  if (!data["monitors"].is_array()) return json(nullptr);
  for (auto& mon : data["monitors"]) {
    if (mon.value("id", "") != monitor_id) continue;
    try {
      if (mon.value("kind", "") == "pr" && mon.contains("url")) {
        mon["pr"] = github_.fetch_pr_from_url(mon["url"].get<std::string>());
      } else if (mon.value("kind", "") == "jira") {
        const std::string input =
            mon.contains("url") ? mon.value("url", mon.value("summary", "")) : mon.value("summary", "");
        mon["jira"] = jira_.fetch_from_url_or_key(input);
      }
      mon["summary"] = summarize_monitor(mon);
      save_file(data);
      notify_changed();
      return mon;
    } catch (...) {
      return json(nullptr);
    }
  }
  return json(nullptr);
}

int WorkforceStore::refresh_all_monitors() {
  json data = load_file();
  int count = 0;
  if (!data["monitors"].is_array()) return 0;
  for (auto& mon : data["monitors"]) {
    const std::string kind = mon.value("kind", "");
    if (kind != "pr" && kind != "jira") continue;
    try {
      if (kind == "pr" && mon.contains("url")) {
        mon["pr"] = github_.fetch_pr_from_url(mon["url"].get<std::string>());
      } else {
        const std::string input =
            mon.contains("url") ? mon.value("url", mon.value("summary", "")) : mon.value("summary", "");
        mon["jira"] = jira_.fetch_from_url_or_key(input);
      }
      mon["summary"] = summarize_monitor(mon);
      ++count;
    } catch (...) {
    }
  }
  data["lastPollAt"] = now_ms();
  save_file(data);
  notify_changed();
  return count;
}

void WorkforceStore::pin_kanban_task(const std::string& task_id, bool pinned) {
  const json tasks = kanban_.list();
  if (!tasks.is_array()) return;
  for (const auto& t : tasks) {
    if (t.value("id", "") != task_id) continue;
    json updated = t;
    updated["officePinned"] = pinned;
    kanban_.save(updated);
    notify_changed();
    return;
  }
}

json WorkforceStore::add_monitor_from_kanban(const std::string& task_id) {
  const json tasks = kanban_.list();
  if (!tasks.is_array()) return json(nullptr);
  for (const auto& t : tasks) {
    if (t.value("id", "") != task_id) continue;
    const std::string body = t.value("body", "");
    const std::string monitor_url = t.value("monitorUrl", "");
    const std::string text = body + "\n" + monitor_url;

    static const std::regex gh(R"(https?://github\.com/[^\s]+)", std::regex::icase);
    std::smatch gm;
    if (std::regex_search(text, gm, gh)) {
      const auto parsed = GitHubClient::parse_pr_url(gm.str());
      if (parsed) {
        const auto& [owner, repo, num] = *parsed;
        return add_monitor(json{{"title", t.value("title", "")},
                               {"kind", "pr"},
                               {"summary", t.value("title", "")},
                               {"url", "https://github.com/" + owner + "/" + repo + "/pull/" +
                                           std::to_string(num)}});
      }
    }

    const std::string jira_key = JiraClient::parse_issue_key(text);
    if (!jira_key.empty()) {
      return add_monitor(json{{"title", t.value("title", "")},
                              {"kind", "jira"},
                              {"summary", jira_key},
                              {"url", monitor_url.empty() ? jira_key : monitor_url}});
    }

    if (!monitor_url.empty()) {
      if (GitHubClient::parse_pr_url(monitor_url)) {
        return add_monitor(json{{"title", t.value("title", "")},
                               {"kind", "pr"},
                               {"summary", t.value("title", "")},
                               {"url", monitor_url}});
      }
      return add_monitor(json{{"title", t.value("title", "")},
                              {"kind", "jira"},
                              {"summary", t.value("title", "")},
                              {"url", monitor_url}});
    }
    return json(nullptr);
  }
  return json(nullptr);
}

}  // namespace omega::runtime
