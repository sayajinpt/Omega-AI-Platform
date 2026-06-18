#pragma once

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class RouterModelsService {
 public:
  nlohmann::json status() const;
  nlohmann::json install_node_runtime(EventBus& events);
  nlohmann::json setup_python(EventBus& events);
  nlohmann::json build(const std::string& role, EventBus& events);
  nlohmann::json remove(const std::string& role);

 private:
  std::atomic<bool> setup_running_{false};
  std::atomic<bool> build_running_{false};
};

}  // namespace omega::runtime
