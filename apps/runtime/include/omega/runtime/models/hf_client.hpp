#pragma once

#include "omega/runtime/config_store.hpp"

#include <map>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class HfClient {
 public:
  explicit HfClient(ConfigStore& config);

  nlohmann::json search(const nlohmann::json& opts) const;
  nlohmann::json model_card(const std::string& repo) const;
  nlohmann::json common_tags() const;
  nlohmann::json check_repo_access(const std::string& repo) const;
  nlohmann::json repo_file_paths(const std::string& repo) const;

  static std::string encode_repo(const std::string& repo);

 private:
  ConfigStore& config_;
  std::string hf_token() const;
  std::map<std::string, std::string> auth_headers() const;
};

}  // namespace omega::runtime
