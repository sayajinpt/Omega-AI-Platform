#include "omega/runtime/storage/profile_store.hpp"

#include "omega/runtime/util/slugify.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

ProfileStore::ProfileStore(ProfileContext& profile) : profile_(profile) {}

int64_t ProfileStore::safe_mtime(const std::string& path) {
  std::error_code ec;
  if (!fs::exists(path, ec)) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
  const auto ftime = fs::last_write_time(path, ec);
  if (ec) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
  }
  const auto sctp = std::chrono::time_point_cast<std::chrono::milliseconds>(
      std::chrono::clock_cast<std::chrono::system_clock>(ftime));
  return sctp.time_since_epoch().count();
}

void ProfileStore::clone_tree(const std::string& src, const std::string& dst) {
  if (!fs::exists(src)) return;
  fs::create_directories(dst);
  static const char* k_exclude[] = {"models", "cache", "logs", "plugins"};
  for (const auto& entry : fs::directory_iterator(src)) {
    const std::string name = entry.path().filename().string();
    bool skip = false;
    for (const char* ex : k_exclude) {
      if (name == ex) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    const fs::path target = fs::path(dst) / name;
    if (entry.is_directory()) {
      clone_tree(entry.path().string(), target.string());
    } else {
      try {
        std::ifstream in(entry.path(), std::ios::binary);
        std::ofstream out(target, std::ios::binary);
        out << in.rdbuf();
      } catch (...) {
      }
    }
  }
}

json ProfileStore::list() {
  json arr = json::array();
  const std::string active = profile_.active_profile_id();
  const std::string home = profile_.omega_home();
  arr.push_back({{"id", "default"},
                 {"name", "Default"},
                 {"homeDir", home},
                 {"isActive", active == "default"},
                 {"isDefault", true},
                 {"createdAt", safe_mtime(home)}});

  const fs::path root = fs::path(home) / "profiles";
  fs::create_directories(root);
  for (const auto& entry : fs::directory_iterator(root)) {
    if (!entry.is_directory()) continue;
    const std::string id = entry.path().filename().string();
    arr.push_back({{"id", id},
                   {"name", id},
                   {"homeDir", entry.path().string()},
                   {"isActive", active == id},
                   {"isDefault", false},
                   {"createdAt", safe_mtime(entry.path().string())}});
  }
  return arr;
}

json ProfileStore::create(const std::string& id, const std::string& clone_from) {
  const std::string slug = slugify(id);
  if (slug.empty() || slug == "default") throw std::runtime_error("invalid profile id");
  const fs::path dir = fs::path(profile_.omega_home()) / "profiles" / slug;
  if (fs::exists(dir)) throw std::runtime_error("profile already exists");
  fs::create_directories(dir);
  if (!clone_from.empty()) {
    std::string src = clone_from == "default"
                          ? profile_.omega_home()
                          : (fs::path(profile_.omega_home()) / "profiles" / clone_from).string();
    clone_tree(src, dir.string());
  }
  return {{"id", slug},
          {"name", slug},
          {"homeDir", dir.string()},
          {"isActive", false},
          {"isDefault", false},
          {"createdAt", safe_mtime(dir.string())}};
}

void ProfileStore::remove(const std::string& id) {
  if (id == "default") throw std::runtime_error("cannot delete default profile");
  const fs::path dir = fs::path(profile_.omega_home()) / "profiles" / id;
  if (fs::exists(dir)) fs::remove_all(dir);
  if (profile_.active_profile_id() == id) switch_to("default");
}

json ProfileStore::switch_to(const std::string& id) {
  profile_.set_active_profile(id);
  profile_.reload_from_disk();
  const json profiles = list();
  for (const auto& p : profiles) {
    if (p.value("id", "") == id) return p;
  }
  throw std::runtime_error("profile not found: " + id);
}

}  // namespace omega::runtime
