#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

struct GlobalEvent {
  std::string channel;
  nlohmann::json payload;
  int64_t ts_ms = 0;
};

class EventBus {
 public:
  void publish(const std::string& channel, const nlohmann::json& payload);
  std::vector<GlobalEvent> poll(size_t& cursor, int timeout_ms);

 private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<GlobalEvent> events_;
  static constexpr size_t k_max = 4096;
};

}  // namespace omega::runtime
