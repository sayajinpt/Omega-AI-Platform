#include "omega/runtime/storage/integrations_store.hpp"

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

IntegrationsStore::IntegrationsStore(ProfileContext& profile) : profile_(profile) {}

std::string IntegrationsStore::path() const {
  return (fs::path(profile_.profile_home()) / "integrations.json").string();
}

json IntegrationsStore::load() const {
  const fs::path p = path();
  if (!fs::exists(p)) return json::object();
  try {
    std::ifstream in(p);
    json root = json::parse(in);
    return root.is_object() ? root : json::object();
  } catch (...) {
    return json::object();
  }
}

json IntegrationsStore::save(const json& cfg) {
  const fs::path p = path();
  fs::create_directories(p.parent_path());
  std::ofstream out(p);
  out << cfg.dump(2);
  return cfg;
}

}  // namespace omega::runtime
