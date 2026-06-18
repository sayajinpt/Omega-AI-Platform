#pragma once

#include "omega/runtime/chat/agent_service.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/services/self_improve_service.hpp"
#include "omega/runtime/services/workforce_store.hpp"
#include "omega/runtime/storage/session_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class WorkforceOrchestrator {
 public:
  WorkforceOrchestrator(WorkforceStore& store, ConfigStore& config, AgentService& agent,
                        InferenceRouter& inference, SelfImproveService& self_improve,
                        SessionStore& sessions, EventBus& events);

  nlohmann::json delegate_task(const std::string& agent_id, const std::string& task,
                               const std::string& parent_run_id = "");
  nlohmann::json run_moa(const std::string& task);
  nlohmann::json run_parallel(const nlohmann::json& tasks);
  nlohmann::json toggle_standup(bool active);
  nlohmann::json run_skill_gym();
  nlohmann::json run_office_janitor();

 private:
  std::string agent_model(const std::string& agent_id);
  nlohmann::json run_single_agent(const std::string& agent_id, const std::string& task,
                                  const std::string& parent_run_id);

  WorkforceStore& store_;
  ConfigStore& config_;
  AgentService& agent_;
  InferenceRouter& inference_;
  SelfImproveService& self_improve_;
  SessionStore& sessions_;
  EventBus& events_;
};

}  // namespace omega::runtime
