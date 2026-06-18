#pragma once

#include "omega/runtime/event_bus.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Maps venv_setup phase callbacks into ContentStudioSetupProgress events for the UI. */
class ContentStudioSetupProgressTracker {
 public:
  explicit ContentStudioSetupProgressTracker(EventBus& events);

  void on_phase(const std::string& phase, const std::string& detail);
  void publish_error(const std::string& message);

 private:
  EventBus& events_;
  nlohmann::json steps_;
  bool running_{false};

  void set_step(const std::string& id, const std::string& status, const std::string& detail = "");
  int percent_done() const;
  void publish(bool running, const std::string& error = "");
};

}  // namespace omega::runtime
