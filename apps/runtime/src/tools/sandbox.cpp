#include "omega/runtime/tools/sandbox.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

ToolResult err(const std::string& msg) { return ToolResult{false, msg, json::array()}; }

ToolResult ok(const std::string& msg) { return ToolResult{true, msg, json::array()}; }

std::string lang_from_path(const std::string& rel_path) {
  const fs::path p(rel_path);
  const std::string ext = p.extension().string();
  if (ext == ".py") return "python";
  if (ext == ".js" || ext == ".mjs" || ext == ".cjs") return "javascript";
  if (ext == ".ts" || ext == ".tsx") return "typescript";
  if (ext == ".sh" || ext == ".bash") return "bash";
  if (ext == ".ps1") return "powershell";
  if (ext == ".json") return "json";
  if (ext == ".md") return "markdown";
  if (ext == ".html" || ext == ".htm") return "html";
  if (ext == ".css") return "css";
  if (ext == ".sql") return "sql";
  if (ext == ".rs") return "rust";
  if (ext == ".go") return "go";
  if (ext == ".cpp" || ext == ".cc" || ext == ".cxx" || ext == ".h" || ext == ".hpp") return "cpp";
  return "text";
}

json code_block_part(const std::string& lang, const std::string& code) {
  return json{{"type", "text"}, {"text", "```" + lang + "\n" + code + "\n```"}};
}

bool path_escapes(const fs::path& root, const fs::path& abs) {
  std::error_code ec;
  const fs::path rel = fs::relative(abs, root, ec);
  if (ec) return true;
  const std::string s = rel.generic_string();
  return s.starts_with("..") || s.find("../") != std::string::npos;
}

constexpr const char* kSandboxEscapeMsg =
    "path is outside the session workspace — use a relative path like test-file.txt, or an "
    "absolute path after host filesystem access is granted";

fs::path normalize_sandbox_target(const fs::path& root, fs::path target) {
  if (target.is_absolute()) {
    throw std::runtime_error(kSandboxEscapeMsg);
  }

  std::string s = target.generic_string();
  while (!s.empty() && (s.front() == '/' || s.front() == '\\')) s.erase(s.begin());
  if (s.empty()) throw std::runtime_error("path is required");
  target = fs::path(s).lexically_normal();
  if (target.generic_string().starts_with("..")) {
    throw std::runtime_error(kSandboxEscapeMsg);
  }
  return target;
}

}  // namespace

Sandbox::Sandbox(std::string sandbox_root) : sandbox_root_(std::move(sandbox_root)) {}

bool Sandbox::path_in_sandbox(const std::string& target) const {
  if (target.empty()) return false;
  try {
    (void)assert_in_sandbox(target);
    return true;
  } catch (...) {
    return false;
  }
}

std::string Sandbox::resolve_host_path(const std::string& target) const {
  if (target.empty()) throw std::runtime_error("path is required");
  fs::path p(target);
  std::error_code ec;
  if (p.is_absolute()) {
    const fs::path canon = fs::weakly_canonical(p, ec);
    return (ec ? p.lexically_normal() : canon).string();
  }
  const fs::path root = fs::absolute(sandbox_root_);
  const fs::path abs = (root / p.lexically_normal()).lexically_normal();
  const fs::path canon = fs::weakly_canonical(abs, ec);
  return (ec ? abs : canon).string();
}

std::string Sandbox::assert_in_sandbox(const std::string& target) const {
  if (target.empty()) throw std::runtime_error("path is required");
  const fs::path root = fs::absolute(sandbox_root_);
  const fs::path rel = normalize_sandbox_target(root, fs::path(target));
  const fs::path abs = (root / rel).lexically_normal();
  if (path_escapes(root, abs)) {
    throw std::runtime_error(kSandboxEscapeMsg);
  }
  std::error_code ec_abs;
  std::error_code ec_root;
  const fs::path canon_abs = fs::weakly_canonical(abs, ec_abs);
  const fs::path canon_root = fs::weakly_canonical(root, ec_root);
  if (!ec_abs && !ec_root && path_escapes(canon_root, canon_abs)) {
    throw std::runtime_error(kSandboxEscapeMsg);
  }
  return (ec_abs ? abs : canon_abs).string();
}

ToolResult Sandbox::fs_read(const std::string& rel_path) const {
  try {
    const std::string path = assert_in_sandbox(rel_path);
    if (!fs::exists(path)) return err("file not found");
    std::ifstream in(path, std::ios::binary);
    return ok(std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()));
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_write(const std::string& rel_path, const std::string& content) const {
  try {
    const fs::path path = assert_in_sandbox(rel_path);
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    out << content;
    const std::string generic = fs::path(rel_path).generic_string();
    json parts = json::array({code_block_part(lang_from_path(generic), content)});
    return ToolResult{true, "wrote " + generic, parts};
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_list(const std::string& rel_path) const {
  try {
    const fs::path path = assert_in_sandbox(rel_path);
    if (!fs::exists(path)) return err("path not found");
    std::ostringstream out;
    bool empty = true;
    for (const auto& entry : fs::directory_iterator(path)) {
      empty = false;
      const char* kind = entry.is_directory() ? "dir" : "file";
      out << kind << '\t' << entry.path().filename().string() << '\n';
    }
    return ok(empty ? "(empty)" : out.str());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_delete(const std::string& rel_path) const {
  try {
    const fs::path path = assert_in_sandbox(rel_path);
    if (!fs::exists(path)) return err("file not found");
    if (fs::is_directory(path)) {
      return err(
          "path is a directory — delete individual files under it with list_dir + delete_file");
    }
    fs::remove(path);
    return ok("deleted " + fs::path(rel_path).generic_string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_stat(const std::string& rel_path) const {
  try {
    const fs::path path = assert_in_sandbox(rel_path);
    if (!fs::exists(path)) return err("file not found");
    const auto st = fs::status(path);
    const auto ftime = fs::last_write_time(path);
    const auto sctp = std::chrono::time_point_cast<std::chrono::milliseconds>(
        std::chrono::clock_cast<std::chrono::system_clock>(ftime));
    json payload{{"path", fs::path(rel_path).generic_string()},
                 {"kind", fs::is_directory(st) ? "dir" : "file"},
                 {"size_bytes", fs::is_regular_file(st) ? static_cast<int64_t>(fs::file_size(path))
                                                         : 0},
                 {"modified_ms", sctp.time_since_epoch().count()}};
    return ok(payload.dump());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_copy(const std::string& rel_src, const std::string& rel_dest) const {
  try {
    const fs::path src = assert_in_sandbox(rel_src);
    const fs::path dest = assert_in_sandbox(rel_dest);
    if (!fs::exists(src)) return err("source not found");
    fs::create_directories(dest.parent_path());
    fs::copy_file(src, dest, fs::copy_options::overwrite_existing);
    return ok("copied " + fs::path(rel_src).generic_string() + " → " +
              fs::path(rel_dest).generic_string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::fs_move(const std::string& rel_src, const std::string& rel_dest) const {
  try {
    const fs::path src = assert_in_sandbox(rel_src);
    const fs::path dest = assert_in_sandbox(rel_dest);
    if (!fs::exists(src)) return err("source not found");
    fs::create_directories(dest.parent_path());
    fs::rename(src, dest);
    return ok("moved " + fs::path(rel_src).generic_string() + " → " +
              fs::path(rel_dest).generic_string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::grep_project(const std::string& pattern, const std::string& subpath,
                                 int max_files, int max_matches) const {
  const std::string raw = pattern;
  if (raw.empty()) return err("pattern is required (regex)");
  std::regex re;
  try {
    re = std::regex(raw, std::regex_constants::icase);
  } catch (const std::exception& e) {
    return err(e.what());
  }
  max_files = std::min(80, std::max(1, max_files));
  max_matches = std::min(200, std::max(1, max_matches));

  const fs::path root = fs::absolute(sandbox_root_);
  const fs::path scan_root = fs::absolute(assert_in_sandbox(subpath));
  static const std::regex ext_re(
      R"(\.(ts|tsx|js|jsx|py|json|md|txt|csv|yaml|yml|html|css|sql|sh|ps1|toml)$)",
      std::regex_constants::icase);

  json hits = json::array();
  int files_scanned = 0;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(
           scan_root, fs::directory_options::skip_permission_denied, ec);
       it != fs::recursive_directory_iterator(); it.increment(ec)) {
    if (ec) continue;
    if (!it->is_regular_file()) continue;
    if (files_scanned >= max_files) break;
    const std::string fname = it->path().filename().string();
    if (!std::regex_search(fname, ext_re)) continue;
    ++files_scanned;
    std::ifstream in(it->path());
    std::string line;
    int line_no = 0;
    while (std::getline(in, line)) {
      ++line_no;
      if (!std::regex_search(line, re)) continue;
      const fs::path rel = fs::relative(it->path(), root, ec);
      hits.push_back({{"file", rel.generic_string()},
                      {"line", line_no},
                      {"text", line.substr(0, 240)}});
      if (static_cast<int>(hits.size()) >= max_matches) break;
    }
    if (static_cast<int>(hits.size()) >= max_matches) break;
  }
  return ok(json{{"pattern", raw},
                 {"files_scanned", files_scanned},
                 {"match_count", hits.size()},
                 {"matches", hits}}
                .dump());
}

ToolResult Sandbox::glob_project(const std::string& pattern, const std::string& subpath) const {
  const std::string pat = pattern;
  if (pat.empty()) return err("pattern is required (e.g. **/*.py or src/**/*.ts)");
  const fs::path root = fs::absolute(sandbox_root_);
  const fs::path scan_root = fs::absolute(assert_in_sandbox(subpath));

  std::string suffix = pat;
  if (suffix.starts_with("**/")) suffix = suffix.substr(3);
  if (suffix.starts_with("*")) suffix = suffix.substr(1);

  std::string escaped;
  for (char c : suffix) {
    if (c == '.') escaped += "\\.";
    else if (c == '*') escaped += ".*";
    else escaped += c;
  }
  const std::regex ext_re(escaped + "$", std::regex_constants::icase);

  json paths = json::array();
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(
           scan_root, fs::directory_options::skip_permission_denied, ec);
       it != fs::recursive_directory_iterator() && paths.size() < 100; it.increment(ec)) {
    if (ec || !it->is_regular_file()) continue;
    const std::string name = it->path().filename().string();
    if (name == "node_modules" || name == ".git") continue;
    if (!std::regex_search(name, ext_re)) continue;
    const fs::path rel = fs::relative(it->path(), root, ec);
    paths.push_back(rel.generic_string());
  }
  return ok(json{{"pattern", pat}, {"count", paths.size()}, {"paths", paths}}.dump());
}

ToolResult Sandbox::host_fs_read(const std::string& path) const {
  try {
    const std::string abs = resolve_host_path(path);
    if (!fs::exists(abs)) return err("file not found");
    if (fs::is_directory(abs)) return err("path is a directory — use list_dir");
    std::ifstream in(abs, std::ios::binary);
    return ok(std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()));
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_write(const std::string& path, const std::string& content) const {
  try {
    const fs::path abs = resolve_host_path(path);
    fs::create_directories(abs.parent_path());
    std::ofstream out(abs, std::ios::binary);
    out << content;
    json parts = json::array({code_block_part(lang_from_path(abs.filename().string()), content)});
    return ToolResult{true, "wrote " + abs.string(), parts};
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_list(const std::string& path) const {
  try {
    const fs::path abs = resolve_host_path(path.empty() ? "." : path);
    if (!fs::exists(abs)) return err("path not found");
    std::ostringstream out;
    bool empty = true;
    for (const auto& entry : fs::directory_iterator(abs)) {
      empty = false;
      const char* kind = entry.is_directory() ? "dir" : "file";
      out << kind << '\t' << entry.path().filename().string() << '\n';
    }
    return ok(empty ? "(empty)" : out.str());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_delete(const std::string& path) const {
  try {
    const fs::path abs = resolve_host_path(path);
    if (!fs::exists(abs)) return err("file not found");
    if (fs::is_directory(abs)) {
      return err(
          "path is a directory — delete individual files under it with list_dir + delete_file");
    }
    fs::remove(abs);
    return ok("deleted " + abs.string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_stat(const std::string& path) const {
  try {
    const fs::path abs = resolve_host_path(path);
    if (!fs::exists(abs)) return err("file not found");
    const auto st = fs::status(abs);
    const auto ftime = fs::last_write_time(abs);
    const auto sctp = std::chrono::time_point_cast<std::chrono::milliseconds>(
        std::chrono::clock_cast<std::chrono::system_clock>(ftime));
    json payload{{"path", abs.string()},
                 {"kind", fs::is_directory(st) ? "dir" : "file"},
                 {"size_bytes", fs::is_regular_file(st) ? static_cast<int64_t>(fs::file_size(abs))
                                                         : 0},
                 {"modified_ms", sctp.time_since_epoch().count()}};
    return ok(payload.dump());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_copy(const std::string& src, const std::string& dest) const {
  try {
    const fs::path s = resolve_host_path(src);
    const fs::path d = resolve_host_path(dest);
    if (!fs::exists(s)) return err("source not found");
    fs::create_directories(d.parent_path());
    fs::copy_file(s, d, fs::copy_options::overwrite_existing);
    return ok("copied " + s.string() + " → " + d.string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_fs_move(const std::string& src, const std::string& dest) const {
  try {
    const fs::path s = resolve_host_path(src);
    const fs::path d = resolve_host_path(dest);
    if (!fs::exists(s)) return err("source not found");
    fs::create_directories(d.parent_path());
    fs::rename(s, d);
    return ok("moved " + s.string() + " → " + d.string());
  } catch (const std::exception& e) {
    return err(e.what());
  }
}

ToolResult Sandbox::host_grep(const std::string& pattern, const std::string& subpath, int max_files,
                              int max_matches) const {
  const std::string raw = pattern;
  if (raw.empty()) return err("pattern is required (regex)");
  std::regex re;
  try {
    re = std::regex(raw, std::regex_constants::icase);
  } catch (const std::exception& e) {
    return err(e.what());
  }
  max_files = std::min(80, std::max(1, max_files));
  max_matches = std::min(200, std::max(1, max_matches));

  const fs::path scan_root = fs::path(resolve_host_path(subpath.empty() ? "." : subpath));
  static const std::regex ext_re(
      R"(\.(ts|tsx|js|jsx|py|json|md|txt|csv|yaml|yml|html|css|sql|sh|ps1|toml)$)",
      std::regex_constants::icase);

  json hits = json::array();
  int files_scanned = 0;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(
           scan_root, fs::directory_options::skip_permission_denied, ec);
       it != fs::recursive_directory_iterator(); it.increment(ec)) {
    if (ec) continue;
    if (!it->is_regular_file()) continue;
    if (files_scanned >= max_files) break;
    const std::string fname = it->path().filename().string();
    if (!std::regex_search(fname, ext_re)) continue;
    ++files_scanned;
    std::ifstream in(it->path());
    std::string line;
    int line_no = 0;
    while (std::getline(in, line)) {
      ++line_no;
      if (!std::regex_search(line, re)) continue;
      hits.push_back({{"file", it->path().string()}, {"line", line_no}, {"text", line.substr(0, 240)}});
      if (static_cast<int>(hits.size()) >= max_matches) break;
    }
    if (static_cast<int>(hits.size()) >= max_matches) break;
  }
  return ok(json{{"pattern", raw},
                 {"files_scanned", files_scanned},
                 {"match_count", hits.size()},
                 {"matches", hits}}
                .dump());
}

ToolResult Sandbox::host_glob(const std::string& pattern, const std::string& subpath) const {
  const std::string pat = pattern;
  if (pat.empty()) return err("pattern is required (e.g. **/*.py or src/**/*.ts)");
  const fs::path scan_root = fs::path(resolve_host_path(subpath.empty() ? "." : subpath));

  std::string suffix = pat;
  if (suffix.starts_with("**/")) suffix = suffix.substr(3);
  if (suffix.starts_with("*")) suffix = suffix.substr(1);

  std::string escaped;
  for (char c : suffix) {
    if (c == '.') escaped += "\\.";
    else if (c == '*') escaped += ".*";
    else escaped += c;
  }
  const std::regex ext_re(escaped + "$", std::regex_constants::icase);

  json paths = json::array();
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(
           scan_root, fs::directory_options::skip_permission_denied, ec);
       it != fs::recursive_directory_iterator() && paths.size() < 100; it.increment(ec)) {
    if (ec || !it->is_regular_file()) continue;
    const std::string name = it->path().filename().string();
    if (name == "node_modules" || name == ".git") continue;
    if (!std::regex_search(name, ext_re)) continue;
    paths.push_back(it->path().string());
  }
  return ok(json{{"pattern", pat}, {"count", paths.size()}, {"paths", paths}}.dump());
}

}  // namespace omega::runtime
