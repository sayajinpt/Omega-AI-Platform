#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class GatewayStore {
 public:
  explicit GatewayStore(ProfileContext& profile);

  nlohmann::json list() const;
  nlohmann::json save(const nlohmann::json& cfg);
  void remove(const std::string& id);
  std::optional<nlohmann::json> find(const std::string& id) const;

 private:
  ProfileContext& profile_;
  std::string file_path() const;
  nlohmann::json load_all() const;
  void persist(const nlohmann::json& rows) const;
};

}  // namespace omega::runtime
