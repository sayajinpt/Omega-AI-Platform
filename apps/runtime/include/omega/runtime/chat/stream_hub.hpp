#pragma once

#include <nlohmann/json.hpp>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace omega::runtime {

/** In-memory stream events for SSE subscribers (streamId from chat send). */
class StreamHub {
 public:
  struct Event {
    std::string type;
    nlohmann::json payload;
  };

  void publish(const std::string& stream_id, const std::string& type, const nlohmann::json& payload);
  void finish(const std::string& stream_id, const nlohmann::json& result);
  void error(const std::string& stream_id, const std::string& message);

  /** Returns events since cursor; blocks up to timeout_ms for new data. */
  std::vector<Event> poll(const std::string& stream_id, size_t& cursor, int timeout_ms = 500);

  bool is_done(const std::string& stream_id) const;
  std::optional<nlohmann::json> result(const std::string& stream_id) const;

  void remove(const std::string& stream_id);

 private:
  struct StreamState {
    std::deque<Event> events;
    bool done = false;
    nlohmann::json final_result;
    std::string error;
    std::condition_variable cv;
  };

  mutable std::mutex mu_;
  std::unordered_map<std::string, StreamState> streams_;
};

}  // namespace omega::runtime
