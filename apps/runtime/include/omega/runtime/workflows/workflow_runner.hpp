#pragma once

#include <atomic>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>

namespace omega::runtime {

class AgentService;
class EventBus;
class InferenceRouter;
class ToolRegistry;

class WorkflowRunner {
 public:
  WorkflowRunner(InferenceRouter& inference, ToolRegistry& tools, AgentService& agent, EventBus& events);

  nlohmann::json run(const nlohmann::json& workflow, const nlohmann::json& initial_vars,
                     const std::string& model_id);
  nlohmann::json abort(const std::string& run_id = "");

 private:
  void emit_event(const nlohmann::json& event);
  bool is_aborted(const std::string& run_id);
  std::string run_node(const nlohmann::json& node, std::unordered_map<std::string, std::string>& vars,
                       const std::string& default_model);

  InferenceRouter& inference_;
  ToolRegistry& tools_;
  AgentService& agent_;
  EventBus& events_;
  mutable std::mutex runs_mu_;
  std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> abort_flags_;
};

}  // namespace omega::runtime
