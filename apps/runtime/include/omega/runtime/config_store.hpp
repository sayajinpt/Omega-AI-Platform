#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class ConfigStore {
 public:
  nlohmann::json load();
  nlohmann::json save_patch(const nlohmann::json& patch);

 private:
  nlohmann::json defaults() const;
  void ensure_dirs(const nlohmann::json& cfg) const;
};

}  // namespace omega::runtime
