#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

struct ToolResult {
  bool ok = false;
  std::string output;
  nlohmann::json parts = nlohmann::json::array();
};

/** Workspace-scoped file operations (chat project or config sandboxRoot). */
class Sandbox {
 public:
  explicit Sandbox(std::string sandbox_root);

  void set_root(std::string root) { sandbox_root_ = std::move(root); }
  const std::string& root() const { return sandbox_root_; }

  /** True when the path resolves inside this sandbox (relative project paths). */
  bool path_in_sandbox(const std::string& target) const;

  ToolResult fs_read(const std::string& rel_path) const;
  ToolResult fs_write(const std::string& rel_path, const std::string& content) const;
  ToolResult fs_list(const std::string& rel_path = ".") const;
  ToolResult fs_delete(const std::string& rel_path) const;
  ToolResult fs_stat(const std::string& rel_path) const;
  ToolResult fs_copy(const std::string& rel_src, const std::string& rel_dest) const;
  ToolResult fs_move(const std::string& rel_src, const std::string& rel_dest) const;
  ToolResult grep_project(const std::string& pattern, const std::string& subpath = ".",
                          int max_files = 40, int max_matches = 60) const;
  ToolResult glob_project(const std::string& pattern, const std::string& subpath = ".") const;

  /** User-granted access outside the session workspace (absolute paths, etc.). */
  ToolResult host_fs_read(const std::string& path) const;
  ToolResult host_fs_write(const std::string& path, const std::string& content) const;
  ToolResult host_fs_list(const std::string& path = ".") const;
  ToolResult host_fs_delete(const std::string& path) const;
  ToolResult host_fs_stat(const std::string& path) const;
  ToolResult host_fs_copy(const std::string& src, const std::string& dest) const;
  ToolResult host_fs_move(const std::string& src, const std::string& dest) const;
  ToolResult host_grep(const std::string& pattern, const std::string& subpath, int max_files,
                       int max_matches) const;
  ToolResult host_glob(const std::string& pattern, const std::string& subpath) const;

 private:
  std::string assert_in_sandbox(const std::string& target) const;
  std::string resolve_host_path(const std::string& target) const;

  std::string sandbox_root_;
};

}  // namespace omega::runtime
