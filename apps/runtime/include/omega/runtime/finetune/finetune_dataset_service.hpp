#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class FinetuneDatasetService {
 public:
  explicit FinetuneDatasetService(ProfileContext& profile);

  std::string datasets_root() const;
  nlohmann::json list_prepared() const;
  nlohmann::json list_presets() const;
  nlohmann::json save_preset(const nlohmann::json& input);
  void delete_preset(const std::string& id);
  nlohmann::json inspect_source(const std::string& path) const;
  nlohmann::json pick_sources(const nlohmann::json& body) const;
  bool delete_prepared(const std::string& id);
  nlohmann::json prepare_dataset(const nlohmann::json& req);

 private:
  ProfileContext& profile_;
  std::string presets_path() const;
  nlohmann::json load_presets() const;
  void persist_presets(const nlohmann::json& items) const;
};

}  // namespace omega::runtime
