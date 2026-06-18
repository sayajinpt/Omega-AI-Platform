#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ModelConfigStore {
 public:
  nlohmann::json list() const;
  nlohmann::json get(const std::string& model_id) const;
  nlohmann::json set(const std::string& model_id, const nlohmann::json& patch);
  nlohmann::json reset(const std::string& model_id);

 private:
  std::string file_path() const;
  nlohmann::json load_all() const;
  void persist(const nlohmann::json& all) const;
  static std::string normalize_key(const std::string& model_id);
  static nlohmann::json defaults();
};

}  // namespace omega::runtime
