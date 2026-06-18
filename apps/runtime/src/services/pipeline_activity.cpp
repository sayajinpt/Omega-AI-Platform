#include "omega/runtime/services/pipeline_activity.hpp"

#include <chrono>

using json = nlohmann::json;

namespace omega::runtime {

json PipelineActivityService::snapshot() const {
  std::lock_guard lock(mu_);
  return state_;
}

void PipelineActivityService::set(const json& patch) {
  std::lock_guard lock(mu_);
  for (auto it = patch.begin(); it != patch.end(); ++it) {
    state_[it.key()] = it.value();
  }
  state_["updatedAt"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
}

void PipelineActivityService::clear(const std::string& subsystem) {
  std::lock_guard lock(mu_);
  if (!subsystem.empty() && state_.value("subsystem", "") != subsystem) return;
  state_ = json{{"subsystem", "idle"},
                {"label", "Idle"},
                {"stage", "Waiting"},
                {"updatedAt", std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count()}};
}

}  // namespace omega::runtime
