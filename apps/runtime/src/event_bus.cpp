#include "omega/runtime/event_bus.hpp"

namespace omega::runtime {

void EventBus::publish(const std::string& channel, const nlohmann::json& payload) {
  GlobalEvent ev;
  ev.channel = channel;
  ev.payload = payload;
  ev.ts_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                 std::chrono::system_clock::now().time_since_epoch())
                 .count();
  {
    std::lock_guard lock(mu_);
    events_.push_back(std::move(ev));
    while (events_.size() > k_max) {
      events_.pop_front();
    }
  }
  cv_.notify_all();
}

std::vector<GlobalEvent> EventBus::poll(size_t& cursor, int timeout_ms) {
  std::unique_lock lock(mu_);
  if (cursor > events_.size()) cursor = events_.size();
  if (cursor >= events_.size()) {
    cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                 [&] { return cursor < events_.size(); });
  }
  std::vector<GlobalEvent> out;
  while (cursor < events_.size()) {
    out.push_back(events_[cursor++]);
  }
  return out;
}

}  // namespace omega::runtime
