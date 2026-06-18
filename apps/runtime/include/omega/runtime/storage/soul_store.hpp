#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>

namespace omega::runtime {

class SoulStore {
 public:
  explicit SoulStore(ProfileContext& profile);

  nlohmann::json get();
  nlohmann::json set(const nlohmann::json& input);
  nlohmann::json reset();

 private:
  std::string soul_path() const;
  static nlohmann::json default_soul();
  static nlohmann::json parse_soul_md(const std::string& md);
  static std::string serialize_soul(const nlohmann::json& soul);

  ProfileContext& profile_;
};

}  // namespace omega::runtime
