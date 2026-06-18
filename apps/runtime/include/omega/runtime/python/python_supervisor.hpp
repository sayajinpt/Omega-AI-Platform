#pragma once

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class PythonSupervisor {
 public:
  nlohmann::json status() const;
  nlohmann::json run_setup(const std::string& profile, EventBus& events);
  bool setup_running() const { return setup_running_.load(); }

 private:
  std::atomic<bool> setup_running_{false};
};

}  // namespace omega::runtime
