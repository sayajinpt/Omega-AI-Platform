#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace omega::runtime {

struct RouteCatalogEntry {
  std::string key;
  std::string ipc;
  std::string domain;
  std::string target;
  int phase = 0;
  std::string status;
  std::string engine_command;
  nlohmann::json http;
  nlohmann::json ws;
};

class RouteCatalog {
 public:
  bool load_from_file(const std::string& path);
  const std::vector<RouteCatalogEntry>& routes() const { return routes_; }
  nlohmann::json summary() const;
  nlohmann::json to_json() const;
  /** Resolve IPC channel for catalogued HTTP route (method + path). */
  std::optional<std::string> ipc_for_http(const std::string& method, const std::string& path) const;

 private:
  std::vector<RouteCatalogEntry> routes_;
  nlohmann::json meta_;
};

}  // namespace omega::runtime
