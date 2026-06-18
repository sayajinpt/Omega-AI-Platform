#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/profile_context.hpp"

#include <deque>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class TerminalStore {
 public:
  explicit TerminalStore(EventBus& events);

  nlohmann::json history() const;
  void clear();
  nlohmann::json append_line(const std::string& kind, const std::string& text);
  nlohmann::json run_snippet(ConfigStore& config, ProfileContext& profile,
                             const nlohmann::json& opts);
  nlohmann::json save_snippet(ProfileContext& profile, const std::string& content,
                              const std::string& suggested_name);

 private:
  nlohmann::json push_line(const std::string& kind, const std::string& text);

  EventBus& events_;
  mutable std::mutex mu_;
  std::deque<nlohmann::json> lines_;
  int seq_ = 0;
  static constexpr size_t k_max = 800;
};

}  // namespace omega::runtime
