#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace omega {

namespace {

void add_unique_dir(std::vector<std::wstring>& dirs, const fs::path& p) {
  if (p.empty()) return;
  std::error_code ec;
  if (!fs::is_directory(p, ec)) return;
  const auto canon = fs::weakly_canonical(p, ec);
  const std::wstring w = ec ? p.wstring() : canon.wstring();
  for (const auto& existing : dirs) {
    if (_wcsicmp(existing.c_str(), w.c_str()) == 0) return;
  }
  dirs.push_back(w);
}

}  // namespace

void init_shared_dll_search_paths() {
  std::vector<std::wstring> dirs;

  if (const char* env = std::getenv("OMEGA_BIN_DIR")) {
    if (*env) add_unique_dir(dirs, fs::path(env));
  }

  wchar_t module_path[MAX_PATH]{};
  const DWORD n = GetModuleFileNameW(nullptr, module_path, MAX_PATH);
  if (n > 0 && n < MAX_PATH) {
    const fs::path engine_dir = fs::path(module_path).parent_path();
    add_unique_dir(dirs, engine_dir.parent_path() / "bin");
  }

  if (dirs.empty()) return;

  if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS)) {
    return;
  }

  for (const auto& dir : dirs) {
    DLL_DIRECTORY_COOKIE cookie = AddDllDirectory(dir.c_str());
    if (cookie) {
      // Keep cookie alive for process lifetime (no FreeLibraryDirectoryCookie).
      static std::vector<DLL_DIRECTORY_COOKIE> cookies;
      cookies.push_back(cookie);
    }
  }
}

}  // namespace omega

#endif
