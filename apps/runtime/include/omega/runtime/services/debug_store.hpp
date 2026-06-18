#pragma once

#include "omega/runtime/event_bus.hpp"

#include <deque>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class DebugStore {
 public:
  explicit DebugStore(EventBus& events);

  void log(const std::string& source, const std::string& message,
           const std::string& level = "info", const nlohmann::json& data = nlohmann::json());
  nlohmann::json history() const;

 private:
  static constexpr size_t k_max = 2000;
  EventBus& events_;
  mutable std::mutex mu_;
  std::deque<nlohmann::json> events_buf_;
};

}  // namespace omega::runtime
