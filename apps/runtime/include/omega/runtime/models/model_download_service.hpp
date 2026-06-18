#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/models/hf_client.hpp"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

class ModelDownloadService {
 public:
  ModelDownloadService(ConfigStore& config, HfClient& hf, EventBus& events);

  nlohmann::json download(const std::string& repo, const std::string& filename);
  nlohmann::json download_bundle(const std::string& repo, const std::vector<std::string>& paths);
  nlohmann::json download_required(const nlohmann::json& req);
  nlohmann::json cancel(const std::string& repo, const std::string& filename);
  nlohmann::json download_adapter(const std::string& repo, const std::string& filename);

 private:
  using ProgressFn = std::function<void(const nlohmann::json&)>;

  std::string dest_path_for_repo_file(const std::string& repo, const std::string& filename) const;
  std::string adapter_dest_path(const std::string& repo, const std::string& filename) const;
  void write_repo_sidecar(const std::string& repo, const std::string& filename) const;
  void emit_inventory_changed() const;
  std::string download_to_path(const std::string& repo, const std::string& filename,
                               const std::string& dest_path, ProgressFn on_progress);
  std::vector<std::string> resolve_required_paths(const nlohmann::json& req) const;

  ConfigStore& config_;
  HfClient& hf_;
  EventBus& events_;
};

}  // namespace omega::runtime
