#include "omega/runtime/services/debug_store.hpp"

#include <chrono>

using json = nlohmann::json;

namespace omega::runtime {

DebugStore::DebugStore(EventBus& events) : events_(events) {}

void DebugStore::log(const std::string& source, const std::string& message, const std::string& level,
                     const json& data) {
  const json ev{{"ts", std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count()},
                {"level", level},
                {"source", source},
                {"message", message},
                {"data", data}};
  {
    std::lock_guard lock(mu_);
    events_buf_.push_front(ev);
    while (events_buf_.size() > k_max) events_buf_.pop_back();
  }
  events_.publish("omega:debug:event", ev);
}

json DebugStore::history() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (const auto& e : events_buf_) out.push_back(e);
  return out;
}

}  // namespace omega::runtime
