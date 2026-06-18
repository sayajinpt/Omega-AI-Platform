#include "omega/runtime/storage/gateway_store.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

GatewayStore::GatewayStore(ProfileContext& profile) : profile_(profile) {}

std::string GatewayStore::file_path() const {
  return (fs::path(profile_.profile_home()) / "gateway.json").string();
}

json GatewayStore::load_all() const {
  const fs::path path = file_path();
  if (!fs::exists(path)) return json::array();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void GatewayStore::persist(const json& rows) const {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << rows.dump(2);
}

json GatewayStore::list() const { return load_all(); }

std::optional<json> GatewayStore::find(const std::string& id) const {
  for (const auto& row : load_all()) {
    if (row.value("id", "") == id) return row;
  }
  return std::nullopt;
}

json GatewayStore::save(const json& input) {
  if (!input.is_object()) throw std::runtime_error("gateway config must be an object");
  const std::string id = input.value("id", "");
  if (id.empty()) throw std::runtime_error("gateway id required");
  json rows = load_all();
  bool found = false;
  for (auto& row : rows) {
    if (row.value("id", "") == id) {
      row = input;
      found = true;
      break;
    }
  }
  if (!found) rows.push_back(input);
  persist(rows);
  return input;
}

void GatewayStore::remove(const std::string& id) {
  json rows = load_all();
  json next = json::array();
  for (const auto& row : rows) {
    if (row.value("id", "") != id) next.push_back(row);
  }
  persist(next);
}

}  // namespace omega::runtime
