#include "omega/runtime/route_catalog.hpp"

#include <fstream>
#include <stdexcept>

using json = nlohmann::json;

namespace omega::runtime {

bool RouteCatalog::load_from_file(const std::string& path) {
  std::ifstream in(path);
  if (!in) return false;
  try {
    json root = json::parse(in);
    meta_ = root;
    routes_.clear();
    if (!root.contains("routes") || !root["routes"].is_array()) return false;
    for (const auto& row : root["routes"]) {
      RouteCatalogEntry e;
      e.key = row.value("key", "");
      if (row.contains("ipc") && !row["ipc"].is_null()) {
        e.ipc = row["ipc"].get<std::string>();
      }
      e.domain = row.value("domain", "");
      e.target = row.value("target", "cxx");
      e.phase = row.value("phase", 0);
      e.status = row.value("status", "planned");
      if (row.contains("engine_command") && !row["engine_command"].is_null()) {
        e.engine_command = row["engine_command"].get<std::string>();
      }
      e.http = row.contains("http") ? row["http"] : json();
      e.ws = row.contains("ws") ? row["ws"] : json();
      routes_.push_back(std::move(e));
    }
    return true;
  } catch (...) {
    return false;
  }
}

json RouteCatalog::summary() const {
  if (meta_.contains("summary")) return meta_["summary"];
  return json::object();
}

json RouteCatalog::to_json() const {
  json routes = json::array();
  for (const auto& e : routes_) {
    routes.push_back({{"key", e.key},
                      {"ipc", e.ipc.empty() ? json(nullptr) : json(e.ipc)},
                      {"domain", e.domain},
                      {"target", e.target},
                      {"phase", e.phase},
                      {"status", e.status},
                      {"engine_command", e.engine_command.empty() ? json(nullptr) : json(e.engine_command)},
                      {"http", e.http.is_null() ? json(nullptr) : e.http},
                      {"ws", e.ws.is_null() ? json(nullptr) : e.ws}});
  }
  return json{{"version", meta_.value("version", 1)},
              {"summary", summary()},
              {"routes", routes}};
}

std::optional<std::string> RouteCatalog::ipc_for_http(const std::string& method,
                                                      const std::string& path) const {
  for (const auto& e : routes_) {
    if (e.ipc.empty() || e.http.is_null() || !e.http.is_object()) continue;
    if (!e.http.contains("method") || !e.http.contains("path")) continue;
    if (e.http.value("method", "") != method) continue;
    if (e.http.value("path", "") != path) continue;
    return e.ipc;
  }
  return std::nullopt;
}

}  // namespace omega::runtime
