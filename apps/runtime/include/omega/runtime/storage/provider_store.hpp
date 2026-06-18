#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <utility>

namespace omega::runtime {

class ProviderStore {
 public:
  explicit ProviderStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);
  nlohmann::json fetch_models(const std::string& id, bool should_persist = false);
  nlohmann::json presets() const;
  nlohmann::json discover_all();
  std::optional<std::pair<nlohmann::json, std::string>> resolve_model(
      const std::string& qualified_model_id) const;

 private:
  std::string file_path() const;
  nlohmann::json load_all() const;
  void persist(const nlohmann::json& rows) const;

  ProfileContext& profile_;
};

}  // namespace omega::runtime
