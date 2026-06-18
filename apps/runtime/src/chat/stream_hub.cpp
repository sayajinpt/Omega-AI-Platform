#include "omega/runtime/chat/stream_hub.hpp"

#include <chrono>

using json = nlohmann::json;

namespace omega::runtime {

void StreamHub::publish(const std::string& stream_id, const std::string& type,
                        const json& payload) {
  std::lock_guard lock(mu_);
  auto& st = streams_[stream_id];
  st.events.push_back(Event{type, payload});
  st.cv.notify_all();
}

void StreamHub::finish(const std::string& stream_id, const json& result) {
  std::lock_guard lock(mu_);
  auto& st = streams_[stream_id];
  st.done = true;
  st.final_result = result;
  st.events.push_back(Event{"done", result});
  st.cv.notify_all();
}

void StreamHub::error(const std::string& stream_id, const std::string& message) {
  std::lock_guard lock(mu_);
  auto& st = streams_[stream_id];
  st.done = true;
  st.error = message;
  st.events.push_back(Event{"error", json{{"message", message}}});
  st.cv.notify_all();
}

std::vector<StreamHub::Event> StreamHub::poll(const std::string& stream_id, size_t& cursor,
                                              int timeout_ms) {
  std::unique_lock lock(mu_);
  auto wait_for_data = [&]() {
    const auto it = streams_.find(stream_id);
    if (it == streams_.end()) return true;
    return it->second.events.size() > cursor || it->second.done;
  };
  if (!wait_for_data()) {
    auto& st = streams_[stream_id];
    st.cv.wait_for(lock, std::chrono::milliseconds(timeout_ms), wait_for_data);
  }
  const auto it = streams_.find(stream_id);
  if (it == streams_.end()) return {};
  std::vector<Event> out;
  while (cursor < it->second.events.size()) {
    out.push_back(it->second.events[cursor]);
    ++cursor;
  }
  return out;
}

bool StreamHub::is_done(const std::string& stream_id) const {
  std::lock_guard lock(mu_);
  const auto it = streams_.find(stream_id);
  return it != streams_.end() && it->second.done;
}

std::optional<json> StreamHub::result(const std::string& stream_id) const {
  std::lock_guard lock(mu_);
  const auto it = streams_.find(stream_id);
  if (it == streams_.end() || !it->second.done) return std::nullopt;
  if (!it->second.error.empty()) return json{{"error", it->second.error}};
  return it->second.final_result;
}

void StreamHub::remove(const std::string& stream_id) {
  std::lock_guard lock(mu_);
  streams_.erase(stream_id);
}

}  // namespace omega::runtime
