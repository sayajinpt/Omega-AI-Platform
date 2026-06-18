#include "omega/runtime/storage/project_store.hpp"

#include <filesystem>
#include <fstream>
#include <regex>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

ProjectStore::ProjectStore(ProfileContext& profile) : profile_(profile) {}

std::string ProjectStore::projects_root() const {
  return (fs::path(profile_.profile_home()) / "projects").string();
}

std::string ProjectStore::sanitize_id(const std::string& session_id) {
  const std::string id = session_id;
  if (id.empty()) throw std::runtime_error("session id required");
  static const std::regex ok(R"(^[a-zA-Z0-9_-]+$)");
  if (!std::regex_match(id, ok)) throw std::runtime_error("invalid session id for project path");
  return id;
}

std::string ProjectStore::project_dir(const std::string& session_id) const {
  return (fs::path(projects_root()) / sanitize_id(session_id)).string();
}

std::string ProjectStore::ensure_dir(const std::string& session_id, const std::string& title) {
  const std::string root = project_dir(session_id);
  fs::create_directories(root);
  for (const char* sub : {"code", "images", "files", "media"}) {
    fs::create_directories(fs::path(root) / sub);
  }
  const fs::path readme = fs::path(root) / "README.md";
  if (!fs::exists(readme)) {
    const std::string t = title.empty() ? "Chat" : title;
    std::ofstream out(readme);
    out << "# " << t << "\n\nOmega project folder for this chat.\n\nSession id: `" << session_id
        << "`\n";
  }
  return root;
}

bool ProjectStore::remove_session_project(const std::string& session_id) {
  try {
    const fs::path dir = project_dir(session_id);
    std::error_code ec;
    if (!fs::exists(dir, ec)) return true;
    fs::remove_all(dir, ec);
    return !ec;
  } catch (...) {
    return false;
  }
}

json ProjectStore::list_files(const std::string& session_id, int max) const {
  json out = json::array();
  const fs::path root = project_dir(session_id);
  if (!fs::exists(root)) return out;
  for (const char* sub : {"code", "images", "files", "media"}) {
    const fs::path dir = root / sub;
    if (!fs::exists(dir)) continue;
    for (const auto& entry : fs::directory_iterator(dir)) {
      if (!entry.is_regular_file()) continue;
      out.push_back(json{{"sub", sub},
                         {"name", entry.path().filename().string()},
                         {"path", entry.path().string()}});
      if (static_cast<int>(out.size()) >= max) return out;
    }
  }
  return out;
}

std::string ProjectStore::open_folder(const std::string& session_id) {
  return ensure_dir(session_id);
}

}  // namespace omega::runtime
