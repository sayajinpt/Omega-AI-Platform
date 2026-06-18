#include "omega/runtime/profile_context.hpp"

#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace omega::runtime {

ProfileContext::ProfileContext(std::string omega_home)
    : omega_home_(std::move(omega_home)), active_id_("default") {
  reload_from_disk();
}

void ProfileContext::reload_from_disk() {
  active_id_ = "default";
  const fs::path file = fs::path(omega_home_) / "active_profile";
  if (!fs::exists(file)) return;
  try {
    std::ifstream in(file);
    std::string id;
    in >> id;
    if (!id.empty()) active_id_ = id;
  } catch (...) {
    active_id_ = "default";
  }
}

std::string ProfileContext::active_profile_id() const { return active_id_; }

std::string ProfileContext::profile_home() const {
  if (active_id_ == "default" || active_id_.empty()) return omega_home_;
  return (fs::path(omega_home_) / "profiles" / active_id_).string();
}

void ProfileContext::set_active_profile(const std::string& id) {
  active_id_ = id.empty() ? "default" : id;
  fs::create_directories(fs::path(omega_home_));
  std::ofstream out(fs::path(omega_home_) / "active_profile");
  out << active_id_;
  const fs::path home = profile_home();
  fs::create_directories(home);
}

}  // namespace omega::runtime
