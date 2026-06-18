#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ProjectStore {
 public:
  explicit ProjectStore(ProfileContext& profile);

  std::string ensure_dir(const std::string& session_id, const std::string& title = "");
  /** Delete ~/.omega/projects/<session-id>/ (code, media, files, images). */
  bool remove_session_project(const std::string& session_id);
  nlohmann::json list_files(const std::string& session_id, int max = 200) const;
  std::string open_folder(const std::string& session_id);

 private:
  ProfileContext& profile_;
  static std::string sanitize_id(const std::string& session_id);
  std::string projects_root() const;
  std::string project_dir(const std::string& session_id) const;
};

}  // namespace omega::runtime
