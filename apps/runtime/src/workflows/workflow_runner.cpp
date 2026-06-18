#include "omega/runtime/workflows/workflow_runner.hpp"

#include "omega/runtime/chat/agent_service.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/tools/tool_registry.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <queue>
#include <regex>
#include <stdexcept>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string apply_vars(const std::string& tmpl,
                       const std::unordered_map<std::string, std::string>& vars) {
  static const std::regex re(R"(\{\{\s*(\w+)\s*\}\})");
  std::string out;
  std::string::const_iterator search_start(tmpl.cbegin());
  std::smatch m;
  while (std::regex_search(search_start, tmpl.cend(), m, re)) {
    out.append(search_start, m.prefix().second);
    const auto it = vars.find(m[1].str());
    out.append(it != vars.end() ? it->second : "");
    search_start = m.suffix().first;
  }
  out.append(search_start, tmpl.cend());
  return out;
}

std::vector<json> topo_sort(const json& wf) {
  const json nodes = wf.contains("nodes") && wf["nodes"].is_array() ? wf["nodes"] : json::array();
  const json edges = wf.contains("edges") && wf["edges"].is_array() ? wf["edges"] : json::array();

  std::unordered_map<std::string, int> incoming;
  std::unordered_map<std::string, json> by_id;
  for (const auto& n : nodes) {
    const std::string id = n.value("id", "");
    if (!id.empty()) {
      incoming[id] = 0;
      by_id[id] = n;
    }
  }
  for (const auto& e : edges) {
    const std::string to = e.value("to", "");
    if (!to.empty() && incoming.count(to)) incoming[to]++;
  }

  std::queue<std::string> queue;
  for (const auto& n : nodes) {
    const std::string id = n.value("id", "");
    if (!id.empty() && incoming[id] == 0) queue.push(id);
  }

  std::vector<json> order;
  while (!queue.empty()) {
    const std::string id = queue.front();
    queue.pop();
    const auto it = by_id.find(id);
    if (it != by_id.end()) order.push_back(it->second);

    for (const auto& e : edges) {
      if (e.value("from", "") != id) continue;
      const std::string to = e.value("to", "");
      if (!to.empty() && incoming.count(to)) {
        incoming[to]--;
        if (incoming[to] == 0) queue.push(to);
      }
    }
  }
  return order;
}

std::string lower_trim(std::string s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t')) s.erase(s.begin());
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.pop_back();
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

}  // namespace

WorkflowRunner::WorkflowRunner(InferenceRouter& inference, ToolRegistry& tools, AgentService& agent,
                               EventBus& events)
    : inference_(inference), tools_(tools), agent_(agent), events_(events) {}

void WorkflowRunner::emit_event(const json& event) { events_.publish("omega:workflows:event", event); }

bool WorkflowRunner::is_aborted(const std::string& run_id) {
  std::lock_guard lock(runs_mu_);
  const auto it = abort_flags_.find(run_id);
  return it != abort_flags_.end() && it->second->load();
}

json WorkflowRunner::abort(const std::string& run_id) {
  std::lock_guard lock(runs_mu_);
  if (run_id.empty()) {
    for (auto& [_, flag] : abort_flags_) flag->store(true);
    abort_flags_.clear();
    return json{{"aborted", true}};
  }
  const auto it = abort_flags_.find(run_id);
  if (it != abort_flags_.end()) {
    it->second->store(true);
    abort_flags_.erase(it);
  }
  return json{{"aborted", true}};
}

std::string WorkflowRunner::run_node(const json& node,
                                     std::unordered_map<std::string, std::string>& vars,
                                     const std::string& default_model) {
  const std::string kind = node.value("kind", "");
  const std::string model =
      node.contains("model") && node["model"].is_string() ? node["model"].get<std::string>()
                                                          : default_model;

  if (kind == "prompt") {
    const std::string prompt = apply_vars(node.value("prompt", ""), vars);
    const std::string system = node.value("system", "You are Omega.");
    const int max_tokens = node.value("maxTokens", 1024);
    const double temperature = node.value("temperature", 0.5);

    json messages = json::array({json{{"role", "system"}, {"content", system}},
                                 json{{"role", "user"}, {"content", prompt}}});
    json payload{{"model", model},
                 {"messages", messages},
                 {"sampling", json{{"max_tokens", max_tokens}, {"temperature", temperature}}}};
    std::string text;
    const json data = inference_.chat(payload, random_uuid() + "-wf",
                                      [&](const std::string& chunk, int) { text += chunk; }, {},
                                      600000);
    text = data.value("text", text);
    while (!text.empty() && (text.back() == '\n' || text.back() == ' ')) text.pop_back();
    return text;
  }

  if (kind == "tool") {
    const std::string tool_name = node.value("tool", "");
    json args = json::object();
    if (node.contains("args") && node["args"].is_object()) {
      for (auto it = node["args"].begin(); it != node["args"].end(); ++it) {
        args[it.key()] = apply_vars(it.value().is_string() ? it.value().get<std::string>()
                                                           : it.value().dump(),
                                    vars);
      }
    }
    const json tr = tools_.run(tool_name, args);
    return tr.value("output", "");
  }

  if (kind == "agent") {
    const std::string input = apply_vars(node.value("input", ""), vars);
    const int max_steps = node.value("maxSteps", 6);
    const json result =
        agent_.run(json{{"model", model}, {"input", input}, {"maxSteps", max_steps}});
    return result.value("output", "");
  }

  if (kind == "branch") {
    const std::string cond = lower_trim(apply_vars(node.value("condition", ""), vars));
    if (cond == "true" || cond == "1" || cond == "yes") return "true";
    return "false";
  }

  if (kind == "set") {
    return apply_vars(node.value("value", ""), vars);
  }

  throw std::runtime_error("unknown workflow node kind: " + kind);
}

json WorkflowRunner::run(const json& wf, const json& initial_vars, const std::string& model_id) {
  const std::string run_id = random_uuid();
  auto abort_flag = std::make_shared<std::atomic<bool>>(false);
  {
    std::lock_guard lock(runs_mu_);
    abort_flags_[run_id] = abort_flag;
  }
  struct RunCleanup {
    WorkflowRunner* self;
    std::string id;
    ~RunCleanup() {
      std::lock_guard lock(self->runs_mu_);
      self->abort_flags_.erase(id);
    }
  } cleanup{this, run_id};

  std::unordered_map<std::string, std::string> vars;
  if (initial_vars.is_object()) {
    for (auto it = initial_vars.begin(); it != initial_vars.end(); ++it) {
      if (it.value().is_string()) vars[it.key()] = it.value().get<std::string>();
      else vars[it.key()] = it.value().dump();
    }
  }

  json outputs = json::object();
  const std::vector<json> order = topo_sort(wf);

  emit_event(json{{"runId", run_id},
                  {"kind", "start"},
                  {"workflowId", wf.value("id", "")},
                  {"at", now_ms()}});

  try {
    for (const auto& node : order) {
      if (abort_flag->load()) break;
      const std::string node_id = node.value("id", "");
      emit_event(json{{"runId", run_id},
                      {"kind", "nodeStart"},
                      {"nodeId", node_id},
                      {"label", node.value("label", "")},
                      {"at", now_ms()}});

      try {
        const std::string out = run_node(node, vars, model_id);
        outputs[node_id] = out;
        if (node.contains("output") && node["output"].is_string()) {
          vars[node["output"].get<std::string>()] = out;
        }
        const std::string preview = out.size() > 800 ? out.substr(0, 800) : out;
        emit_event(json{{"runId", run_id},
                        {"kind", "nodeDone"},
                        {"nodeId", node_id},
                        {"output", preview},
                        {"at", now_ms()}});
      } catch (const std::exception& e) {
        emit_event(json{{"runId", run_id},
                        {"kind", "nodeError"},
                        {"nodeId", node_id},
                        {"error", e.what()},
                        {"at", now_ms()}});
        if (!node.value("continueOnError", false)) throw;
      }
    }

    if (abort_flag->load()) {
      emit_event(json{{"runId", run_id}, {"kind", "aborted"}, {"at", now_ms()}});
      json vars_json = json::object();
      for (const auto& [k, v] : vars) vars_json[k] = v;
      return json{{"runId", run_id}, {"outputs", outputs}, {"vars", vars_json}, {"aborted", true}};
    }

    emit_event(json{{"runId", run_id}, {"kind", "done"}, {"at", now_ms()}});
    json vars_json = json::object();
    for (const auto& [k, v] : vars) vars_json[k] = v;
    return json{{"runId", run_id}, {"outputs", outputs}, {"vars", vars_json}, {"ok", true}};
  } catch (const std::exception& e) {
    emit_event(json{{"runId", run_id},
                    {"kind", "error"},
                    {"error", e.what()},
                    {"workflowId", wf.value("id", "")},
                    {"at", now_ms()}});
    throw;
  }

  // unreachable
}

}  // namespace omega::runtime
