#pragma once

#include "omega/runtime/event_bus.hpp"

#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class UpdaterService {
 public:
  explicit UpdaterService(EventBus& events);

  nlohmann::json status() const;
  nlohmann::json check();
  nlohmann::json install();

 private:
  void publish_status() const;
  std::string current_version() const;
  std::string manifest_source() const;
  std::optional<nlohmann::json> load_manifest() const;
  bool is_packaged() const;
  int compare_versions(const std::string& a, const std::string& b) const;

  EventBus& events_;
  mutable std::mutex mu_;
  nlohmann::json status_;
  std::string installer_path_;
};

}  // namespace omega::runtime
