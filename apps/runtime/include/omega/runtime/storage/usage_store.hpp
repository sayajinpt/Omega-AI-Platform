#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class UsageStore {
 public:
  explicit UsageStore(ProfileContext& profile);

  nlohmann::json summary(const std::optional<std::string>& session_id) const;

  /** Append a usage row (tokens + optional cost) for /usage and slash commands. */
  void record(const std::string& session_id, const std::string& model_id, int tokens_in,
              int tokens_out, double cost_usd = 0.0);

  /** Drop usage rows for a deleted chat session. Returns number of rows removed. */
  int remove_session_records(const std::string& session_id);

 private:
  std::string path() const;
  nlohmann::json load_all() const;
  void save_all(const nlohmann::json& rows) const;

  ProfileContext& profile_;
};

}  // namespace omega::runtime
