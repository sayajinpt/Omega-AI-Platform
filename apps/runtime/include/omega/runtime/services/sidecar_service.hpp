#pragma once

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class SidecarService {
 public:
  nlohmann::json status() const;
  nlohmann::json install(const nlohmann::json& body, EventBus& events);
  nlohmann::json uninstall();

 private:
  static bool probe_import(const std::string& component);

  std::atomic<bool> install_running_{false};
};

}  // namespace omega::runtime
