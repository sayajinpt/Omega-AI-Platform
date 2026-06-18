#include "omega/runtime/services/mcp_omega_handler.hpp"

using json = nlohmann::json;

namespace omega::runtime {

namespace {

json rpc_ok(const json& id, const json& result) {
  return json{{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
}

json rpc_err(const json& id, int code, const std::string& message) {
  return json{{"jsonrpc", "2.0"}, {"id", id}, {"error", json{{"code", code}, {"message", message}}}};
}

}  // namespace

json handle_omega_mcp_request(const std::string& body, SessionStore& sessions, MemoryStore& memory,
                              ToolRegistry& tools) {
  json req;
  try {
    req = json::parse(body);
  } catch (...) {
    return rpc_err(nullptr, -32700, "parse error");
  }

  const json id = req.contains("id") ? req["id"] : json(nullptr);
  const std::string method = req.value("method", "");

  try {
    if (method == "initialize") {
      return rpc_ok(id, json{{"protocolVersion", "2024-11-05"},
                             {"capabilities", json{{"tools", json::object()}, {"resources", json::object()}}},
                             {"serverInfo", json{{"name", "Omega"}, {"version", "0.2.0"}}}});
    }
    if (method == "tools/list") {
      json listed = tools.list();
      json out = json::array();
      if (listed.is_array()) {
        for (const auto& t : listed) {
          if (!t.value("enabled", true)) continue;
          out.push_back(json{{"name", t.value("name", "")},
                             {"description", t.value("description", "")},
                             {"inputSchema",
                              json{{"type", "object"}, {"properties", json::object()}, {"additionalProperties", true}}}});
        }
      }
      return rpc_ok(id, json{{"tools", out}});
    }
    if (method == "tools/call") {
      const json params = req.contains("params") ? req["params"] : json::object();
      const std::string name = params.value("name", "");
      if (name.empty()) return rpc_err(id, -32602, "tool name required");
      json args_json = params.contains("arguments") ? params["arguments"] : json::object();
      json args = json::object();
      if (args_json.is_object()) {
        for (auto it = args_json.begin(); it != args_json.end(); ++it) {
          args[it.key()] = it.value().is_string() ? it.value().get<std::string>() : it.value().dump();
        }
      }
      const json tr = tools.run(name, args);
      return rpc_ok(id, json{{"content", json::array({json{{"type", "text"}, {"text", tr.value("output", "")}}})},
                             {"isError", !tr.value("ok", false)}});
    }
    if (method == "resources/list") {
      const json session_rows = sessions.list_sessions();
      json resources = json::array();
      if (session_rows.is_array()) {
        size_t n = 0;
        for (const auto& s : session_rows) {
          if (n++ >= 50) break;
          resources.push_back(json{{"uri", "omega://sessions/" + s.value("id", "")},
                                   {"name", s.value("title", "Session")},
                                   {"mimeType", "text/markdown"}});
        }
      }
      return rpc_ok(id, json{{"resources", resources}});
    }
    if (method == "resources/read") {
      const json params = req.contains("params") ? req["params"] : json::object();
      const std::string uri = params.value("uri", "");
      const std::string prefix = "omega://sessions/";
      if (uri.rfind(prefix, 0) != 0) return rpc_err(id, -32602, "unknown resource uri");
      const std::string session_id = uri.substr(prefix.size());
      const json msgs = sessions.get_messages(session_id);
      std::string text;
      if (msgs.is_array()) {
        for (const auto& m : msgs) {
          text += "## " + m.value("role", "") + "\n" + m.value("content", "") + "\n\n";
        }
      }
      return rpc_ok(id, json{{"contents", json::array({json{{"uri", uri}, {"mimeType", "text/markdown"}, {"text", text}}})}});
    }
    if (method == "memory/search") {
      const json params = req.contains("params") ? req["params"] : json::object();
      const std::string query = params.value("query", "");
      const int limit = params.value("limit", 8);
      return rpc_ok(id, json{{"hits", memory.search(query, limit)}});
    }
    if (method == "notifications/initialized" || method == "ping") {
      return json::object();
    }
    return rpc_err(id, -32601, "method not found: " + method);
  } catch (const std::exception& e) {
    return rpc_err(id, -32603, e.what());
  }
}

}  // namespace omega::runtime
