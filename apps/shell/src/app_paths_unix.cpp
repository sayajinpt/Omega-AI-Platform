#include "omega/shell/app_paths.hpp"

#include <cstdlib>
#include <filesystem>
#include <vector>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace omega::shell {

namespace {

std::string env_or_empty(const char* key) {
  const char* v = std::getenv(key);
  return v && *v ? v : "";
}

std::string home_dir() {
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

std::string runtime_exe_name() { return "omega-runtime"; }
std::string engine_exe_name() { return "omega-engine"; }

}  // namespace

std::string omega_home() {
  const std::string from_env = env_or_empty("OMEGA_HOME");
  if (!from_env.empty()) return from_env;
  return (fs::path(home_dir()) / ".omega").string();
}

std::string exe_dir() {
#if defined(__APPLE__)
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::vector<char> buf(size);
  if (_NSGetExecutablePath(buf.data(), &size) != 0) return ".";
  return fs::path(buf.data()).parent_path().string();
#elif defined(__linux__)
  char buf[4096];
  const ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (n <= 0) return ".";
  buf[n] = '\0';
  return fs::path(buf).parent_path().string();
#else
  return ".";
#endif
}

std::string ui_root() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "ui",
      base / ".." / "Resources" / "ui",
      base / ".." / "ui",
      base / ".." / ".." / "dist" / "ui",
      base / "resources" / "ui"
  });
  return picked.string();
}

std::string runtime_binary_path() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "runtime" / runtime_exe_name(),
      base / ".." / "Resources" / "runtime" / runtime_exe_name(),
      base / ".." / "runtime" / runtime_exe_name(),
      base / ".." / ".." / "dist" / "runtime" / runtime_exe_name(),
      base / "resources" / "runtime" / runtime_exe_name()
  });
  return picked.string();
}

std::string engine_binary_path() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "engine" / engine_exe_name(),
      base / ".." / "Resources" / "engine" / engine_exe_name(),
      base / ".." / "engine" / engine_exe_name(),
      base / ".." / ".." / "dist" / "engine" / engine_exe_name(),
      base / "resources" / "engine" / engine_exe_name()
  });
  return picked.empty() ? (base / ".." / ".." / "dist" / "engine" / engine_exe_name()).string()
                        : picked.string();
}

std::string ollama_binary_path() {
  const fs::path base(exe_dir());
  const char* name = "omega-ollama";
  const fs::path picked = first_existing({
      base / "bin" / name,
      base / ".." / "Resources" / "bin" / name,
      base / ".." / "bin" / name,
      base / ".." / ".." / "dist" / "bin" / name,
      base / "resources" / "bin" / name
  });
  return picked.string();
}

std::string bundled_bin_dir() {
  const fs::path base(exe_dir());
  const fs::path picked = first_existing({
      base / "bin",
      base / ".." / "Resources" / "bin",
      base / ".." / "bin",
      base / ".." / ".." / "dist" / "bin",
      base / "resources" / "bin"
  });
  return picked.string();
}

std::string engine_binary_dir() {
  fs::path p(engine_binary_path());
  return p.parent_path().string();
}

std::string augmented_path() {
  std::string path = env_or_empty("PATH");
  const char sep = ':';
  auto prepend = [&](const std::string& dir) {
    if (dir.empty() || !file_exists(dir)) return;
    if (!path.empty()) path = dir + sep + path;
    else path = dir;
  };
  prepend(bundled_bin_dir());
  prepend(engine_binary_dir());
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
