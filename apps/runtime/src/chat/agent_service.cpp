#include "omega/runtime/chat/agent_service.hpp"

#include "omega/runtime/agent/parse_tool_calls.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <chrono>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

json step(const std::string& kind, const std::string& title) {
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();
  return json{{"id", random_uuid()},
              {"kind", kind},
              {"title", title},
              {"status", "running"},
              {"startedAt", now}};
}

}  // namespace

AgentService::AgentService(EngineClient& engine, MemoryStore& memory, ToolRegistry& tools,
                           StreamHub& streams)
    : engine_(engine), memory_(memory), tools_(tools), streams_(streams) {}

json AgentService::run(const json& req) {
  const std::string run_id = random_uuid();
  active_run_id_ = run_id;
  const std::string model = req.value("model", "");
  const std::string input = req.value("input", "");
  const std::string system = req.value("systemPrompt", req.value("system_prompt", ""));
  const int max_steps = req.value("maxSteps", 10);

  json steps = json::array();
  json observations = json::array();

  try {
    const json mem_hits = memory_.search(input, 4);
    if (mem_hits.is_array()) {
      for (const auto& h : mem_hits) observations.push_back(h.value("content", ""));
    }
  } catch (...) {
  }

  json tool_doc = tools_.list();
  std::string tool_lines;
  if (tool_doc.is_array()) {
    for (const auto& t : tool_doc) {
      if (!t.value("enabled", true)) continue;
      tool_lines += "- " + t.value("name", "") + ": " + t.value("description", "") + "\n";
    }
  }

  json messages = json::array();
  std::string sys = system.empty() ? "You are Omega agent. Use ```tool blocks for tools." : system;
  sys += "\n\nTools:\n" + tool_lines;
  if (!observations.empty()) {
    sys += "\n\nMemory:\n";
    for (const auto& o : observations) sys += "- " + o.get<std::string>() + "\n";
  }
  messages.push_back(json{{"role", "system"}, {"content", sys}});
  messages.push_back(json{{"role", "user"}, {"content", input}});

  std::string output;
  const int max_rounds = std::min(max_steps, 6);

  for (int round = 0; round < max_rounds; ++round) {
    json s = step("plan", round == 0 ? "Agent run" : "Tool round");
    steps.push_back(s);

    json payload{{"model", model}, {"messages", messages}, {"sampling", json{{"max_tokens", 700}}}};
    const std::string chat_id = run_id + "-a" + std::to_string(round);
    std::string round_text;
    const json data = engine_.chat_send(
        payload, chat_id, [&](const std::string& text, int) { round_text += text; }, {}, 600000);
    round_text = data.value("text", round_text);

    s["status"] = "done";
    const auto calls = finalize_tool_calls(parse_tool_calls(round_text), round_text, input);
    if (calls.empty()) {
      output = strip_tool_fences(round_text);
      break;
    }

    json exec = step("tool", calls.front().name);
    steps.push_back(exec);

    std::string lines;
    for (const auto& call : calls) {
      json args = json::object();
      for (const auto& [k, v] : call.args) args[k] = v;
      const json tr = tools_.run(call.name, args);
      lines += "[" + call.name + "]: " + tr.value("output", "") + "\n";
    }
    exec["status"] = "done";

    messages.push_back(json{{"role", "assistant"}, {"content", strip_tool_fences(round_text)}});
    messages.push_back(json{{"role", "user"},
                            {"content", "Tool results:\n" + lines + "\nContinue the subtask."}});
    output = strip_tool_fences(round_text);
  }

  active_run_id_.clear();
  return json{{"runId", run_id}, {"steps", steps}, {"output", output}};
}

json AgentService::abort() {
  if (!active_run_id_.empty()) {
    try {
      engine_.chat_abort(active_run_id_);
    } catch (...) {
    }
  }
  active_run_id_.clear();
  return json{{"aborted", true}};
}

}  // namespace omega::runtime
