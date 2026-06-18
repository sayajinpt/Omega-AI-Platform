#include "omega/engine/event_bus.hpp"

namespace omega::engine {

void EventBus::subscribe(const std::string& type, EventListener listener) {
  std::lock_guard lock(mutex_);
  listeners_[type].push_back(std::move(listener));
}

void EventBus::emit(const Event& event) {
  std::vector<EventListener> copy;
  {
    std::lock_guard lock(mutex_);
    const auto it = listeners_.find(event.type);
    if (it != listeners_.end()) copy = it->second;
  }
  for (const auto& listener : copy) {
    listener(event);
  }
}

}  // namespace omega::engine
