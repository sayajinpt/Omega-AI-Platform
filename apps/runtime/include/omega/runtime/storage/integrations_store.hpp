#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>

namespace omega::runtime {

class IntegrationsStore {
 public:
  explicit IntegrationsStore(ProfileContext& profile);

  nlohmann::json load() const;
  nlohmann::json save(const nlohmann::json& cfg);

 private:
  std::string path() const;

  ProfileContext& profile_;
};

}  // namespace omega::runtime
