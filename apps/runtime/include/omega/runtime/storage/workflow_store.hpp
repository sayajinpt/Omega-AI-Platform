#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace omega::runtime {

/** Persisted workflows at ~/.omega/workflows.json */
class WorkflowStore {
 public:
  explicit WorkflowStore(std::string omega_home);

  nlohmann::json list();
  nlohmann::json get(const std::string& id);
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);

 private:
  std::string file_path_;
  std::vector<nlohmann::json> cache_;
  bool loaded_ = false;

  void ensure_loaded();
  void persist();
  int64_t now_ms() const;
};

}  // namespace omega::runtime
