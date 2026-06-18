#include "omega/runtime/services/mcp_client_manager.hpp"

#include "omega/runtime/event_bus.hpp"

#include <atomic>
#include <chrono>
#include <future>
#include <httplib.h>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string quote_arg(const std::string& arg) {
  if (arg.find_first_of(" \t\"") == std::string::npos) return arg;
  std::string out = "\"";
  for (char c : arg) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += '"';
  return out;
}

#ifdef _WIN32
void apply_env(const json& env) {
  if (!env.is_object()) return;
  for (auto it = env.begin(); it != env.end(); ++it) {
    if (it.value().is_string()) {
      SetEnvironmentVariableA(it.key().c_str(), it.value().get<std::string>().c_str());
    }
  }
}
#endif

struct HttpTarget {
  std::string host;
  int port = 80;
  std::string path = "/";
  httplib::Headers headers;
};

bool parse_http_url(const std::string& url, HttpTarget& out) {
  const std::string http = "http://";
  if (url.rfind(http, 0) != 0) return false;
  std::string rest = url.substr(http.size());
  std::string hostport;
  const size_t slash = rest.find('/');
  if (slash == std::string::npos) {
    hostport = rest;
    out.path = "/";
  } else {
    hostport = rest.substr(0, slash);
    out.path = rest.substr(slash);
    if (out.path.empty()) out.path = "/";
  }
  const size_t colon = hostport.find(':');
  if (colon == std::string::npos) {
    out.host = hostport;
    out.port = 80;
  } else {
    out.host = hostport.substr(0, colon);
    out.port = std::stoi(hostport.substr(colon + 1));
  }
  return !out.host.empty();
}

}  // namespace

struct McpClientManager::Connection {
  std::string id;
  json status;
  json tools = json::array();
  json resources = json::array();
  int next_id = 1;
  std::mutex rpc_mu;
  std::mutex io_mu;
  std::string buffer;
  std::unordered_map<int, std::promise<json>> pending;

  std::atomic<bool> alive{true};
  std::thread reader;

#ifdef _WIN32
  HANDLE proc = nullptr;
  HANDLE stdin_wr = nullptr;
  HANDLE stdout_rd = nullptr;
#endif

  std::optional<HttpTarget> http;
};

McpClientManager::McpClientManager(McpStore& store, EventBus& events)
    : store_(store), events_(events) {}

std::shared_ptr<McpClientManager::Connection> McpClientManager::connection(
    const std::string& id) const {
  std::lock_guard lock(mu_);
  const auto it = connections_.find(id);
  return it != connections_.end() ? it->second : nullptr;
}

void McpClientManager::emit_status() {
  events_.publish("omega:mcp:statusChanged", status_list());
}

json McpClientManager::status_list() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (const auto& [_, conn] : connections_) {
    out.push_back(conn->status);
  }
  return out;
}

void McpClientManager::write_line(Connection& conn, const std::string& line) {
#ifdef _WIN32
  if (conn.stdin_wr) {
    std::string payload = line;
    if (payload.empty() || payload.back() != '\n') payload += '\n';
    DWORD written = 0;
    WriteFile(conn.stdin_wr, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr);
    return;
  }
#endif
  (void)conn;
  (void)line;
}

void McpClientManager::dispatch_message(Connection& conn, const json& msg) {
  if (!msg.contains("id") || msg["id"].is_null()) return;
  int id = 0;
  if (msg["id"].is_number_integer()) id = msg["id"].get<int>();
  else return;

  std::lock_guard lock(conn.rpc_mu);
  const auto it = conn.pending.find(id);
  if (it == conn.pending.end()) return;

  if (msg.contains("error") && msg["error"].is_object()) {
    const std::string err = msg["error"].value("message", "mcp rpc error");
    it->second.set_exception(std::make_exception_ptr(std::runtime_error(err)));
  } else {
    it->second.set_value(msg.contains("result") ? msg["result"] : json::object());
  }
  conn.pending.erase(it);
}

void McpClientManager::on_data(Connection& conn, const std::string& chunk) {
  std::lock_guard lock(conn.io_mu);
  conn.buffer += chunk;
  size_t pos = 0;
  while ((pos = conn.buffer.find('\n')) != std::string::npos) {
    std::string line = conn.buffer.substr(0, pos);
    conn.buffer.erase(0, pos + 1);
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty()) continue;
    try {
      dispatch_message(conn, json::parse(line));
    } catch (...) {
    }
  }
}

void McpClientManager::close_transport(const std::shared_ptr<Connection>& conn) {
  if (!conn) return;
  conn->alive = false;
#ifdef _WIN32
  if (conn->proc) TerminateProcess(conn->proc, 0);
  if (conn->stdout_rd) {
    CloseHandle(conn->stdout_rd);
    conn->stdout_rd = nullptr;
  }
  if (conn->stdin_wr) {
    CloseHandle(conn->stdin_wr);
    conn->stdin_wr = nullptr;
  }
  if (conn->proc) {
    WaitForSingleObject(conn->proc, 3000);
    CloseHandle(conn->proc);
    conn->proc = nullptr;
  }
#endif
  if (conn->reader.joinable()) conn->reader.join();
  conn->http.reset();

  std::lock_guard lock(conn->rpc_mu);
  for (auto& [_, prom] : conn->pending) {
    prom.set_exception(std::make_exception_ptr(std::runtime_error("mcp connection closed")));
  }
  conn->pending.clear();
}

void McpClientManager::open_transport(const std::shared_ptr<Connection>& conn, const json& cfg) {
  const json transport = cfg.contains("transport") ? cfg["transport"] : json::object();
  const std::string kind = transport.value("kind", "");

  if (kind == "http") {
    HttpTarget target;
    if (!parse_http_url(transport.value("url", ""), target)) {
      throw std::runtime_error("invalid mcp http url");
    }
    if (transport.contains("headers") && transport["headers"].is_object()) {
      for (auto it = transport["headers"].begin(); it != transport["headers"].end(); ++it) {
        if (it.value().is_string()) target.headers.emplace(it.key(), it.value().get<std::string>());
      }
    }
    conn->http = target;
    return;
  }

  if (kind != "stdio") throw std::runtime_error("unsupported mcp transport: " + kind);

#ifdef _WIN32
  const std::string command = transport.value("command", "");
  if (command.empty()) throw std::runtime_error("mcp stdio command required");

  apply_env(transport.contains("env") ? transport["env"] : json::object());

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE stdout_rd = nullptr;
  HANDLE stdout_wr = nullptr;
  HANDLE stdin_rd = nullptr;
  HANDLE stdin_wr = nullptr;
  if (!CreatePipe(&stdout_rd, &stdout_wr, &sa, 0) || !CreatePipe(&stdin_rd, &stdin_wr, &sa, 0)) {
    throw std::runtime_error("CreatePipe failed");
  }
  SetHandleInformation(stdout_rd, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stdin_wr, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = stdin_rd;
  si.hStdOutput = stdout_wr;
  si.hStdError = stdout_wr;

  std::string inner = quote_arg(command);
  if (transport.contains("args") && transport["args"].is_array()) {
    for (const auto& arg : transport["args"]) {
      if (arg.is_string()) inner += " " + quote_arg(arg.get<std::string>());
    }
  }

  char comspec_path[MAX_PATH] = {};
  GetEnvironmentVariableA("COMSPEC", comspec_path, MAX_PATH);
  const std::string comspec = comspec_path[0] ? comspec_path : "cmd.exe";
  std::string cmdline = comspec + " /c " + inner;

  PROCESS_INFORMATION pi{};
  const char* cwd = nullptr;
  std::string cwd_str;
  if (transport.contains("cwd") && transport["cwd"].is_string()) {
    cwd_str = transport["cwd"].get<std::string>();
    cwd = cwd_str.c_str();
  }

  std::vector<char> cmd_buf(cmdline.begin(), cmdline.end());
  cmd_buf.push_back('\0');

  if (!CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                      cwd, &si, &pi)) {
    CloseHandle(stdout_rd);
    CloseHandle(stdout_wr);
    CloseHandle(stdin_rd);
    CloseHandle(stdin_wr);
    throw std::runtime_error("CreateProcess failed for mcp server");
  }

  CloseHandle(stdout_wr);
  CloseHandle(stdin_rd);
  CloseHandle(pi.hThread);

  conn->proc = pi.hProcess;
  conn->stdin_wr = stdin_wr;
  conn->stdout_rd = stdout_rd;

  conn->reader = std::thread([conn]() {
    if (!conn->stdout_rd) return;
    char buf[4096];
    while (conn->alive.load()) {
      DWORD n = 0;
      if (!ReadFile(conn->stdout_rd, buf, sizeof(buf) - 1, &n, nullptr) || n == 0) break;
      buf[n] = '\0';
      std::lock_guard lock(conn->io_mu);
      conn->buffer.append(buf, n);
      size_t pos = 0;
      while ((pos = conn->buffer.find('\n')) != std::string::npos) {
        std::string line = conn->buffer.substr(0, pos);
        conn->buffer.erase(0, pos + 1);
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
        if (line.empty()) continue;
        try {
          const json msg = json::parse(line);
          if (!msg.contains("id") || !msg["id"].is_number_integer()) continue;
          const int rid = msg["id"].get<int>();
          std::lock_guard rpc_lock(conn->rpc_mu);
          const auto it = conn->pending.find(rid);
          if (it == conn->pending.end()) continue;
          if (msg.contains("error") && msg["error"].is_object()) {
            const std::string err = msg["error"].value("message", "mcp rpc error");
            it->second.set_exception(std::make_exception_ptr(std::runtime_error(err)));
          } else {
            it->second.set_value(msg.contains("result") ? msg["result"] : json::object());
          }
          conn->pending.erase(it);
        } catch (...) {
        }
      }
    }
  });
#else
  throw std::runtime_error("mcp stdio transport requires Windows in this build");
#endif
}

json McpClientManager::rpc(Connection& conn, const std::string& method, const json& params) {
  const int id = conn.next_id++;
  json req{{"jsonrpc", "2.0"}, {"id", id}, {"method", method}};
  if (!params.is_null()) req["params"] = params;

  std::future<json> fut;
  {
    std::lock_guard lock(conn.rpc_mu);
    auto [it, _] = conn.pending.emplace(id, std::promise<json>{});
    fut = it->second.get_future();
  }

  if (conn.http) {
    httplib::Client cli(conn.http->host, conn.http->port);
    cli.set_connection_timeout(10, 0);
    cli.set_read_timeout(30, 0);
    httplib::Headers headers = conn.http->headers;
    headers.emplace("Content-Type", "application/json");
    headers.emplace("Accept", "application/json");
    const auto res = cli.Post(conn.http->path, headers, req.dump(), "application/json");
    if (!res) throw std::runtime_error("mcp http request failed");
    if (res->status < 200 || res->status >= 300) {
      throw std::runtime_error("mcp HTTP " + std::to_string(res->status));
    }
    std::string body = res->body;
    if (body.rfind("data:", 0) == 0 || body.find("data:") != std::string::npos) {
      const size_t idx = body.find("data:");
      if (idx != std::string::npos) {
        size_t start = idx + 5;
        while (start < body.size() && (body[start] == ' ' || body[start] == '\t')) start++;
        const size_t end = body.find('\n', start);
        body = body.substr(start, end == std::string::npos ? std::string::npos : end - start);
      }
    }
    const json msg = json::parse(body);
    if (msg.contains("error") && msg["error"].is_object()) {
      throw std::runtime_error(msg["error"].value("message", "mcp rpc error"));
    }
    return msg.contains("result") ? msg["result"] : json::object();
  }

  write_line(conn, req.dump());

  if (fut.wait_for(std::chrono::seconds(30)) != std::future_status::ready) {
    std::lock_guard lock(conn.rpc_mu);
    conn.pending.erase(id);
    throw std::runtime_error("mcp rpc timeout: " + method);
  }
  return fut.get();
}

void McpClientManager::initialize_connection(Connection& conn) {
  (void)rpc(conn, "initialize",
            json{{"protocolVersion", "2024-11-05"},
                 {"capabilities", json{{"tools", json::object()}, {"resources", json::object()}}},
                 {"clientInfo", json{{"name", "Omega"}, {"version", "0.2.0"}}}});
  if (!conn.http) {
    write_line(conn, R"({"jsonrpc":"2.0","method":"notifications/initialized"})");
  }
}

json McpClientManager::start(const std::string& id) {
  if (id.empty()) throw std::runtime_error("id required");

  json cfg;
  for (const auto& row : store_.list()) {
    if (row.value("id", "") == id) {
      cfg = row;
      break;
    }
  }
  if (cfg.is_null() || cfg.empty()) return json();

  (void)stop(id);

  auto conn = std::make_shared<Connection>();
  conn->id = id;
  conn->status = json{{"id", id}, {"state", "starting"}, {"toolCount", 0}, {"resourceCount", 0}};

  {
    std::lock_guard lock(mu_);
    connections_[id] = conn;
  }
  emit_status();

  try {
    open_transport(conn, cfg);
    initialize_connection(*conn);

    json tools_result = rpc(*conn, "tools/list");
    conn->tools = tools_result.contains("tools") && tools_result["tools"].is_array()
                      ? tools_result["tools"]
                      : json::array();

    json resources = json::array();
    try {
      const json resources_result = rpc(*conn, "resources/list");
      if (resources_result.contains("resources") && resources_result["resources"].is_array()) {
        resources = resources_result["resources"];
      }
    } catch (...) {
    }
    conn->resources = resources;

    conn->status = json{{"id", id},
                        {"state", "ready"},
                        {"toolCount", conn->tools.size()},
                        {"resourceCount", conn->resources.size()}};
  } catch (const std::exception& e) {
    close_transport(conn);
    conn->status = json{{"id", id},
                        {"state", "error"},
                        {"error", e.what()},
                        {"toolCount", 0},
                        {"resourceCount", 0}};
  }

  emit_status();
  return conn->status;
}

json McpClientManager::stop(const std::string& id) {
  std::shared_ptr<Connection> conn;
  {
    std::lock_guard lock(mu_);
    const auto it = connections_.find(id);
    if (it == connections_.end()) return json{{"id", id}, {"state", "stopped"}};
    conn = it->second;
    connections_.erase(it);
  }

  if (conn) {
    close_transport(conn);
    conn->status = json{{"id", id},
                        {"state", "stopped"},
                        {"toolCount", 0},
                        {"resourceCount", 0}};
  }

  emit_status();
  return json{{"id", id}, {"state", "stopped"}};
}

json McpClientManager::all_tools() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (const auto& [server_id, conn] : connections_) {
    if (conn->status.value("state", "") != "ready") continue;
    if (!conn->tools.is_array()) continue;
    for (const auto& t : conn->tools) {
      const std::string tool_name = t.value("name", "");
      if (tool_name.empty()) continue;
      out.push_back(json{{"name", "mcp:" + server_id + ":" + tool_name},
                         {"description", t.value("description", "MCP tool from " + server_id)},
                         {"serverId", server_id},
                         {"toolName", tool_name}});
    }
  }
  return out;
}

json McpClientManager::call_tool(const std::string& server_id, const std::string& tool_name,
                                 const json& args) {
  std::shared_ptr<Connection> conn;
  {
    std::lock_guard lock(mu_);
    const auto it = connections_.find(server_id);
    if (it == connections_.end()) {
      throw std::runtime_error("mcp server not connected: " + server_id);
    }
    conn = it->second;
  }
  if (conn->status.value("state", "") != "ready") {
    throw std::runtime_error("mcp server not ready: " + server_id);
  }

  const json arguments = args.is_object() ? args : json::object();
  const json result =
      rpc(*conn, "tools/call", json{{"name", tool_name}, {"arguments", arguments}});

  std::string text;
  if (result.contains("content") && result["content"].is_array()) {
    for (const auto& part : result["content"]) {
      if (part.value("type", "") == "text") text += part.value("text", "");
      else text += part.dump();
      if (!text.empty() && text.back() != '\n') text += '\n';
    }
  }
  while (!text.empty() && (text.back() == '\n' || text.back() == ' ')) text.pop_back();

  const bool is_error = result.value("isError", false);
  return json{{"ok", !is_error}, {"output", text.empty() && is_error ? "mcp tool error" : text}};
}

}  // namespace omega::runtime
