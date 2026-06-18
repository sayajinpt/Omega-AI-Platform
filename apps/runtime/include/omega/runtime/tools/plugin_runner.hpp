#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Run plugin index.py tool via unified venv (plugin_invoke.py). */
nlohmann::json invoke_plugin_tool(const std::string& plugin_dir, const std::string& tool_name,
                                  const nlohmann::json& args);

std::string resolve_plugin_invoke_script();

}  // namespace omega::runtime
