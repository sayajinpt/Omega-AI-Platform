#include "omega/runtime/services/workforce_orchestrator.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <sstream>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

WorkforceOrchestrator::WorkforceOrchestrator(WorkforceStore& store, ConfigStore& config,
                                               AgentService& agent, InferenceRouter& inference,
                                               SelfImproveService& self_improve,
                                               SessionStore& sessions, EventBus& events)
    : store_(store),
      config_(config),
      agent_(agent),
      inference_(inference),
      self_improve_(self_improve),
      sessions_(sessions),
      events_(events) {}

std::string WorkforceOrchestrator::agent_model(const std::string& agent_id) {
  const json agents = store_.list_agents();
  if (agents.is_array()) {
    for (const auto& a : agents) {
      if (a.value("id", "") == agent_id) return a.value("modelId", "");
    }
  }
  const json cfg = config_.load();
  return cfg.value("defaultModel", "");
}

json WorkforceOrchestrator::run_single_agent(const std::string& agent_id,
                                               const std::string& task,
                                               const std::string& parent_run_id) {
  const std::string model = agent_model(agent_id);
  if (model.empty()) throw std::runtime_error("no model configured for workforce agent");

  json partial{{"mode", parent_run_id.empty() ? "single" : "delegate"},
               {"task", task},
               {"agentIds", json::array({agent_id})}};
  if (!parent_run_id.empty()) partial["parentRunId"] = parent_run_id;

  json run = store_.create_run(partial);
  run["status"] = "running";
  run["updatedAt"] = now_ms();
  store_.upsert_run(run);
  store_.notify_changed();

  try {
    const json result =
        agent_.run(json{{"model", model}, {"input", task}, {"maxSteps", 8}});
    run["status"] = "done";
    run["output"] = result.value("output", "");
    run["updatedAt"] = now_ms();
    store_.upsert_run(run);
    store_.notify_changed();
    return result.value("output", "");
  } catch (const std::exception& e) {
    run["status"] = "error";
    run["error"] = e.what();
    run["updatedAt"] = now_ms();
    store_.upsert_run(run);
    store_.notify_changed();
    throw;
  }
}

json WorkforceOrchestrator::delegate_task(const std::string& agent_id, const std::string& task,
                                          const std::string& parent_run_id) {
  return run_single_agent(agent_id, task, parent_run_id);
}

json WorkforceOrchestrator::run_moa(const std::string& task) {
  json agents = store_.list_agents();
  json ids = json::array();
  if (agents.is_array()) {
    for (size_t i = 0; i < agents.size() && i < 3; ++i) ids.push_back(agents[i].value("id", ""));
  }
  json run = store_.create_run(json{{"mode", "moa"}, {"task", task}, {"agentIds", ids}});
  run["status"] = "running";
  run["updatedAt"] = now_ms();
  store_.upsert_run(run);
  store_.notify_changed();

  try {
    std::ostringstream drafts;
    if (agents.is_array()) {
      for (size_t i = 0; i < agents.size() && i < 3; ++i) {
        const json& a = agents[i];
        const std::string model = a.value("modelId", agent_model(a.value("id", "")));
        if (model.empty()) continue;
        std::string text;
        inference_.chat(
            json{{"model", model},
                 {"messages",
                  json::array({json{{"role", "system"},
                                      {"content", "You are " + a.value("name", "") + " (" +
                                                        a.value("role", "") +
                                                        "). Answer concisely."}},
                               json{{"role", "user"}, {"content", task}}})},
                 {"sampling", json{{"max_tokens", 800}, {"temperature", 0.5}}}},
            run.value("id", "") + "-moa-" + std::to_string(i),
            [&](const std::string& chunk, int) { text += chunk; });
        drafts << "### " << a.value("name", "") << "\n" << text << "\n\n";
      }
    }

    const std::string synth_model = config_.load().value("defaultModel", "");
    if (synth_model.empty()) throw std::runtime_error("no default model for MoA synthesis");
    std::string merged;
    inference_.chat(
        json{{"model", synth_model},
             {"messages",
              json::array(
                  {json{{"role", "system"},
                        {"content", "Synthesize the best final answer from the agent drafts. Be "
                                      "concise."}},
                   json{{"role", "user"},
                        {"content", "Task: " + task + "\n\nDrafts:\n" + drafts.str()}}})},
             {"sampling", json{{"max_tokens", 1200}, {"temperature", 0.3}}}},
        run.value("id", "") + "-moa-synth", [&](const std::string& chunk, int) { merged += chunk; });

    run["status"] = "done";
    run["output"] = merged;
    run["updatedAt"] = now_ms();
    store_.upsert_run(run);
    store_.notify_changed();
    return merged;
  } catch (const std::exception& e) {
    run["status"] = "error";
    run["error"] = e.what();
    run["updatedAt"] = now_ms();
    store_.upsert_run(run);
    store_.notify_changed();
    throw;
  }
}

json WorkforceOrchestrator::run_parallel(const json& tasks) {
  if (!tasks.is_array() || tasks.empty()) throw std::runtime_error("tasks required");
  json agent_ids = json::array();
  std::string combined;
  for (const auto& t : tasks) {
    agent_ids.push_back(t.value("agentId", ""));
    if (!combined.empty()) combined += " | ";
    combined += t.value("task", "");
  }
  json parent = store_.create_run(
      json{{"mode", "parallel"}, {"task", combined}, {"agentIds", agent_ids}});
  parent["status"] = "running";
  parent["updatedAt"] = now_ms();
  store_.upsert_run(parent);
  store_.notify_changed();

  try {
    json outs = json::array();
    for (const auto& t : tasks) {
      outs.push_back(run_single_agent(t.value("agentId", ""), t.value("task", ""),
                                      parent.value("id", "")));
    }
    std::string joined;
    for (size_t i = 0; i < outs.size(); ++i) {
      if (i) joined += "\n---\n";
      joined += outs[i].get<std::string>();
    }
    parent["status"] = "done";
    parent["output"] = joined;
    parent["updatedAt"] = now_ms();
    store_.upsert_run(parent);
    store_.notify_changed();
    return outs;
  } catch (const std::exception& e) {
    parent["status"] = "error";
    parent["error"] = e.what();
    parent["updatedAt"] = now_ms();
    store_.upsert_run(parent);
    store_.notify_changed();
    throw;
  }
}

json WorkforceOrchestrator::toggle_standup(bool active) {
  store_.set_standup_active(active);
  return store_.snapshot();
}

json WorkforceOrchestrator::run_skill_gym() {
  store_.set_skill_gym_active(true);
  store_.notify_changed();
  try {
    const json result = delegate_task(
        "researcher",
        "Review enabled Omega skills and output a short practice checklist the team should run "
        "this week.");
    store_.set_skill_gym_active(false);
    store_.notify_changed();
    return result;
  } catch (...) {
    store_.set_skill_gym_active(false);
    store_.notify_changed();
    throw;
  }
}

json WorkforceOrchestrator::run_office_janitor() {
  store_.set_janitor_active(true);
  store_.notify_changed();
  int removed = 0;
  int session_count = 0;
  json out;
  try {
    const json sessions = sessions_.list_sessions();
    if (sessions.is_array()) {
      for (size_t i = 0; i < sessions.size() && i < 8; ++i) {
        const std::string sid = sessions[i].value("id", "");
        if (sid.empty()) continue;
        const json r = self_improve_.janitor_session(sid);
        removed += r.value("removed", 0);
        ++session_count;
      }
    }
    out = json{{"sessions", session_count},
               {"removed", removed},
               {"note", "Janitor trimmed " + std::to_string(removed) + " messages across " +
                            std::to_string(session_count) + " sessions"}};
  } catch (...) {
    store_.set_janitor_active(false);
    store_.notify_changed();
    throw;
  }
  store_.set_janitor_active(false);
  store_.notify_changed();
  return out;
}

}  // namespace omega::runtime
