#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ProfileStore {
 public:
  explicit ProfileStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json create(const std::string& id, const std::string& clone_from = "");
  void remove(const std::string& id);
  nlohmann::json switch_to(const std::string& id);

 private:
  static int64_t safe_mtime(const std::string& path);
  static void clone_tree(const std::string& src, const std::string& dst);

  ProfileContext& profile_;
};

}  // namespace omega::runtime
