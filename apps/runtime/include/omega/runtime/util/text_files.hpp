#pragma once

#include <filesystem>
#include <functional>
#include <string>
#include <vector>

namespace omega::runtime {

namespace fs = std::filesystem;

inline bool is_text_extension(const std::string& ext) {
  static const char* k_ext[] = {
      ".txt",  ".md",   ".markdown", ".json", ".csv",  ".tsv",  ".yaml", ".yml",
      ".html", ".htm",  ".xml",      ".log",  ".py",   ".js",   ".ts",   ".tsx",
      ".jsx",  ".go",   ".rs",       ".java", ".c",    ".cpp",  ".h",    ".hpp",
      ".sh",   ".toml"};
  for (const char* e : k_ext) {
    if (ext == e) return true;
  }
  return false;
}

inline std::vector<std::string> chunk_text(const std::string& text, size_t target = 1200,
                                           size_t overlap = 200) {
  std::vector<std::string> chunks;
  size_t i = 0;
  while (i < text.size()) {
    size_t end = std::min(text.size(), i + target);
    if (end < text.size()) {
      const size_t nl = text.rfind('\n', end);
      if (nl != std::string::npos && nl > i + target / 2) end = nl;
    }
    chunks.push_back(text.substr(i, end - i));
    if (end >= text.size()) break;
    i = std::max(i + 1, end - overlap);
  }
  return chunks;
}

inline void walk_text_files(const fs::path& root,
                            const std::function<void(const fs::path&)>& visitor) {
  if (!fs::exists(root)) return;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied,
                                                ec);
       it != fs::recursive_directory_iterator(); it.increment(ec)) {
    if (ec) continue;
    if (!it->is_regular_file()) continue;
    const std::string ext = it->path().extension().string();
    if (!is_text_extension(ext)) continue;
    visitor(it->path());
  }
}

}  // namespace omega::runtime
