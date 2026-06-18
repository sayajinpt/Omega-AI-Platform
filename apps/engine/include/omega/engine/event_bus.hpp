#pragma once

#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "omega/engine/command.hpp"

namespace omega::engine {

using EventListener = std::function<void(const Event&)>;

/** Thread-safe pub/sub for engine events. */
class EventBus {
 public:
  void subscribe(const std::string& type, EventListener listener);
  void emit(const Event& event);

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::vector<EventListener>> listeners_;
};

}  // namespace omega::engine
