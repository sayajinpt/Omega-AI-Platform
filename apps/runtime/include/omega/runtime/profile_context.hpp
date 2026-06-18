#pragma once

#include <string>

namespace omega::runtime {

/** Active profile resolution (~/.omega/active_profile). */
class ProfileContext {
 public:
  explicit ProfileContext(std::string omega_home);

  const std::string& omega_home() const { return omega_home_; }
  std::string profile_home() const;
  std::string active_profile_id() const;
  void set_active_profile(const std::string& id);
  void reload_from_disk();

 private:
  std::string omega_home_;
  std::string active_id_;
};

}  // namespace omega::runtime
