#include "omega/runtime/storage/mcp_store.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

McpStore::McpStore(ProfileContext& profile) : profile_(profile) {}

std::string McpStore::file_path() const {
  return (fs::path(profile_.profile_home()) / "mcp-servers.json").string();
}

json McpStore::load_all() const {
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

void McpStore::persist(const json& rows) const {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << rows.dump(2);
}

json McpStore::list() { return load_all(); }

json McpStore::save(const json& input) {
  if (!input.is_object()) throw std::runtime_error("mcp server must be an object");
  json rows = load_all();
  const std::string id =
      input.contains("id") && input["id"].is_string() ? input["id"].get<std::string>()
                                                      : random_uuid();
  json row = input;
  row["id"] = id;
  bool found = false;
  for (auto& r : rows) {
    if (r.value("id", "") == id) {
      r = row;
      found = true;
      break;
    }
  }
  if (!found) rows.push_back(row);
  persist(rows);
  return row;
}

void McpStore::remove(const std::string& id) {
  json rows = load_all();
  json next = json::array();
  for (const auto& r : rows) {
    if (r.value("id", "") != id) next.push_back(r);
  }
  persist(next);
}

json McpStore::status_list() {
  json out = json::array();
  for (const auto& s : load_all()) {
    out.push_back(json{{"id", s.value("id", "")},
                       {"state", "stopped"},
                       {"toolCount", 0},
                       {"resourceCount", 0}});
  }
  return out;
}

}  // namespace omega::runtime
