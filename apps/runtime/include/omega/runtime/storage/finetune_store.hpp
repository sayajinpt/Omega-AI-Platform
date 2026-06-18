#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class FinetuneStore {
 public:
  explicit FinetuneStore(ProfileContext& profile);

  nlohmann::json list() const;
  std::optional<nlohmann::json> get(const std::string& id) const;
  nlohmann::json create(const nlohmann::json& input);
  nlohmann::json update(const std::string& id, const nlohmann::json& patch);
  void remove(const std::string& id);

 private:
  ProfileContext& profile_;
  std::string store_path() const;
  nlohmann::json load_all() const;
  void persist(const nlohmann::json& rows) const;
};

}  // namespace omega::runtime
