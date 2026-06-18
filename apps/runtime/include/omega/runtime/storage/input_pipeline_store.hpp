#pragma once

#include "omega/runtime/config_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Input pipeline persistence at ~/.omega/input-pipelines.json */
class InputPipelineStore {
 public:
  explicit InputPipelineStore(ConfigStore& config);

  nlohmann::json list();
  nlohmann::json get(const std::string& id);
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);
  nlohmann::json set_active(const std::string& scope, const std::string& id);
  nlohmann::json active_for_scope(const std::string& scope);
  nlohmann::json resolve_path(const nlohmann::json& pipeline);

 private:
  std::string file_path() const;
  void ensure_loaded();
  void persist();
  void ensure_builtin_defaults();
  nlohmann::json seed_defaults();

  ConfigStore& config_;
  nlohmann::json cache_ = nlohmann::json::array();
  bool loaded_ = false;
};

}  // namespace omega::runtime
