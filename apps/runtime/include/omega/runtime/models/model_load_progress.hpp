#pragma once

#include "omega/runtime/event_bus.hpp"

#include <nlohmann/json.hpp>
#include <mutex>
#include <string>

namespace omega::runtime {

/** Tracks last model load progress and publishes omega:models:load-progress. */
class ModelLoadProgress {
 public:
  explicit ModelLoadProgress(EventBus& events);

  void emit(const std::string& model_id, const std::string& phase, const std::string& detail = "");
  /** Direct percent from engine (28–100 during GPU weight load). */
  void emit_percent(const std::string& model_id, int percent, const std::string& detail = "");
  nlohmann::json snapshot() const;

 private:
  static int percent_for_phase(const std::string& phase, int prev);

  EventBus& events_;
  mutable std::mutex mu_;
  nlohmann::json last_;
};

}  // namespace omega::runtime
