#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class McpStore {
 public:
  explicit McpStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);
  nlohmann::json status_list();

 private:
  std::string file_path() const;
  nlohmann::json load_all() const;
  void persist(const nlohmann::json& rows) const;

  ProfileContext& profile_;
};

}  // namespace omega::runtime
