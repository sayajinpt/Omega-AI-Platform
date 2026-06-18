#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class SkillsStore {
 public:
  explicit SkillsStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json get(const std::string& id);
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);
  nlohmann::json toggle(const std::string& id, bool enabled);

 private:
  std::string skills_dir() const;
  std::optional<nlohmann::json> read_skill(const std::string& id, bool include_body) const;

  ProfileContext& profile_;
};

}  // namespace omega::runtime
