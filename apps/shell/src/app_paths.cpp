#include "omega/shell/app_paths.hpp"

#include <Windows.h>

#include <cstdlib>
#include <filesystem>

namespace fs = std::filesystem;

namespace omega::shell {

namespace {

std::string env_or_empty(const char* key) {
  const char* v = std::getenv(key);
  return v && *v ? v : "";
}

std::string home_dir() {
  if (const std::string from_env = env_or_empty("USERPROFILE"); !from_env.empty()) return from_env;
  if (const std::string from_env = env_or_empty("HOME"); !from_env.empty()) return from_env;
  return ".";
}

fs::path first_existing(const std::initializer_list<fs::path>& candidates) {
  for (const auto& c : candidates) {
    std::error_code ec;
    if (fs::exists(c, ec)) return c;
  }
  return candidates.size() ? *candidates.begin() : fs::path{};
}

}  // namespace

std::string omega_home() {
  const std::string from_env = env_or_empty("OMEGA_HOME");
  if (!from_env.empty()) return from_env;
  return (fs::path(home_dir()) / ".omega").string();
}

std::string exe_dir() {
  wchar_t buf[MAX_PATH]{};
  const DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
  if (n == 0) return ".";
  fs::path p(buf);
  return p.parent_path().string();
}

std::string ui_root() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "ui",
      base / ".." / "ui",
      base / ".." / ".." / "dist" / "ui",
      base / "resources" / "ui"
  });
  return picked.string();
}

std::string runtime_binary_path() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "runtime" / "omega-runtime.exe",
      base / ".." / "runtime" / "omega-runtime.exe",
      base / ".." / ".." / "dist" / "runtime" / "omega-runtime.exe",
      base / "resources" / "runtime" / "omega-runtime.exe"
  });
  return picked.string();
}

std::string engine_binary_path() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "engine" / "omega-engine.exe",
      base / ".." / "engine" / "omega-engine.exe",
      base / ".." / ".." / "dist" / "engine" / "omega-engine.exe",
      base / "resources" / "engine" / "omega-engine.exe"
  });
  return picked.empty() ? (base / ".." / ".." / "dist" / "engine" / "omega-engine.exe").string()
                        : picked.string();
}

std::string ollama_binary_path() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "bin" / "omega-ollama.exe",
      base / ".." / "bin" / "omega-ollama.exe",
      base / ".." / ".." / "dist" / "bin" / "omega-ollama.exe",
      base / "resources" / "bin" / "omega-ollama.exe"
  });
  return picked.string();
}

std::string bundled_bin_dir() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "bin",
      base / ".." / "bin",
      base / ".." / ".." / "dist" / "bin",
      base / "resources" / "bin"
  });
  return picked.string();
}

std::string resources_dir() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "resources",
      base / ".." / "resources",
      base / ".." / ".." / "dist" / "native" / "Omega" / "resources"
  });
  return picked.string();
}

std::string engine_binary_dir() {
  fs::path p(engine_binary_path());
  return p.parent_path().string();
}

std::string augmented_path() {
  std::string path = env_or_empty("PATH");
  const char sep = ';';
  auto prepend = [&](const std::string& dir) {
    if (dir.empty() || !file_exists(dir)) return;
    if (path.find(dir) != std::string::npos) return;
    if (!path.empty()) path = dir + sep + path;
    else path = dir;
  };

  prepend(bundled_bin_dir());
  prepend(engine_binary_dir());

  const char* system_root = std::getenv("SystemRoot");
  if (system_root && *system_root) {
    prepend((fs::path(system_root) / "System32").string());
  }

  /** Python / py launcher for GUI sessions with a minimal inherited PATH. */
  if (const char* local = std::getenv("LOCALAPPDATA"); local && *local) {
    const fs::path py_root = fs::path(local) / "Programs" / "Python";
    std::error_code ec;
    if (fs::exists(py_root, ec)) {
      for (const auto& ent : fs::directory_iterator(py_root, ec)) {
        if (ec || !ent.is_directory()) continue;
        prepend(ent.path().string());
        prepend((ent.path() / "Scripts").string());
      }
    }
  }

  return path;
}

bool file_exists(const std::string& path) {
  std::error_code ec;
  return fs::exists(path, ec);
}

std::string content_studio_storage_dir() {
  return (fs::path(omega_home()) / "content-studio" / "storage").string();
}

}  // namespace omega::shell
