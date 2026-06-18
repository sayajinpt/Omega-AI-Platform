#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class PluginStore {
 public:
  nlohmann::json list() const;
  nlohmann::json catalog();
  nlohmann::json toggle(const std::string& id, bool enabled);
  nlohmann::json reload();
  nlohmann::json status() const;
  nlohmann::json install_builtin(const std::string& id);
  nlohmann::json install_from_url(const std::string& url);
  void uninstall(const std::string& id);
  nlohmann::json write_agent_plugin(const nlohmann::json& input);
  /** Mounted plugin tools as pluginId:toolName entries. */
  nlohmann::json plugin_tools() const;
  bool is_plugin_tool(const std::string& namespaced_name) const;

 private:
  nlohmann::json builtin_catalog_template() const;
  std::string plugins_root() const;
  std::string enabled_state_path() const;
  nlohmann::json load_enabled() const;
  void save_enabled(const nlohmann::json& state) const;
  nlohmann::json scan_manifest(const std::string& dir) const;
  std::string builtin_script(const std::string& id) const;
  void write_installed_plugin(const nlohmann::json& entry);
  static std::string sanitize_id(std::string s);
  std::optional<std::string> find_manifest_dir(const std::string& root) const;
};

}  // namespace omega::runtime
