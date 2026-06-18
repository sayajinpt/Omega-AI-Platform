#pragma once

#include "omega/runtime/storage/mcp_store.hpp"

#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>

namespace omega::runtime {

class EventBus;

/** MCP client — stdio + HTTP JSON-RPC transports (Model Context Protocol). */
class McpClientManager {
 public:
  McpClientManager(McpStore& store, EventBus& events);

  nlohmann::json start(const std::string& id);
  nlohmann::json stop(const std::string& id);
  nlohmann::json status_list() const;
  /** Tools from all ready MCP connections (for ToolRegistry). */
  nlohmann::json all_tools() const;
  nlohmann::json call_tool(const std::string& server_id, const std::string& tool_name,
                           const nlohmann::json& args);

 private:
  struct Connection;

  void emit_status();
  std::shared_ptr<Connection> connection(const std::string& id) const;
  nlohmann::json rpc(Connection& conn, const std::string& method,
                     const nlohmann::json& params = nlohmann::json());
  void on_data(Connection& conn, const std::string& chunk);
  void dispatch_message(Connection& conn, const nlohmann::json& msg);
  void open_transport(const std::shared_ptr<Connection>& conn, const nlohmann::json& cfg);
  void close_transport(const std::shared_ptr<Connection>& conn);
  void initialize_connection(Connection& conn);
  void write_line(Connection& conn, const std::string& line);

  McpStore& store_;
  EventBus& events_;
  mutable std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<Connection>> connections_;
};

}  // namespace omega::runtime
