#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ModelQuantizeService {
 public:
  explicit ModelQuantizeService(ConfigStore& config, EventBus& events);

  nlohmann::json quantize(const nlohmann::json& req);

 private:
  void emit_progress(const std::string& status, int percent, const std::string& message) const;

  ConfigStore& config_;
  EventBus& events_;
};

}  // namespace omega::runtime
