#pragma once

#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/tools/tool_registry.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Omega-as-MCP-server JSON-RPC handler (tools/list, tools/call, resources/*). */
nlohmann::json handle_omega_mcp_request(const std::string& body, SessionStore& sessions,
                                        MemoryStore& memory, ToolRegistry& tools);

}  // namespace omega::runtime
