#pragma once

#include <string>
#include <vector>

namespace omega::engine {

/**
 * Native plugin ABI (Phase 13 scaffold).
 * Node plugins run in the Electron main process today via engine-bridge/plugin-loader.
 * Future: load .wasm / platform modules that export omega_plugin_init().
 */
struct PluginToolSpec {
  std::string name;
  std::string description;
  std::string handler_id;
};

struct PluginManifestView {
  std::string id;
  std::string name;
  std::string version;
  std::string description;
  std::vector<std::string> permissions;
  std::vector<PluginToolSpec> tools;
};

/** Result of invoking a mounted plugin tool. */
struct PluginToolResult {
  bool ok = false;
  std::string output;
};

/**
 * Plugin host interface — mirrors @omega/sdk PluginInterface.
 * Implemented by the desktop bridge until plugins run inside omega-engine.
 */
class PluginInterface {
 public:
  virtual ~PluginInterface() = default;

  virtual std::vector<PluginManifestView> list() const = 0;
  virtual bool toggle(const std::string& id, bool enabled) = 0;
  virtual void reload() = 0;
  virtual PluginToolResult run_tool(const std::string& namespaced_name,
                                  const std::string& args_json) = 0;
};

}  // namespace omega::engine
