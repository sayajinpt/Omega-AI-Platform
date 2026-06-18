#include "omega/engine/json_protocol.hpp"
#include "omega/engine/json_safe.hpp"

#include <nlohmann/json.hpp>

namespace omega::engine {

namespace {

using json = nlohmann::json;

}  // namespace

std::optional<Command> JsonProtocol::parse_request(const std::string& line) {
  try {
    const json root = json::parse(line);
    Command cmd;
    cmd.id = root.value("id", "");
    cmd.type = root.value("type", "");
    if (root.contains("payload")) {
      const auto& p = root["payload"];
      cmd.payload_json = p.is_object() || p.is_array() ? p.dump() : p.dump();
    } else {
      cmd.payload_json = "{}";
    }
    if (cmd.type.empty()) return std::nullopt;
    return cmd;
  } catch (...) {
    return std::nullopt;
  }
}

std::string JsonProtocol::serialize_response(const CommandResponse& resp) {
  json root;
  root["id"] = resp.id;
  root["type"] = resp.type;
  root["success"] = resp.success;
  if (!resp.data_json.empty()) {
    try {
      root["data"] = json::parse(resp.data_json);
    } catch (...) {
      root["data"] = json::object();
    }
  }
  if (!resp.error.empty()) root["error"] = resp.error;
  return json_dump_safe(root);
}

std::string JsonProtocol::serialize_event(const Event& event) {
  return serialize_event(event.type, event.payload_json, event.at_ms);
}

std::string JsonProtocol::serialize_event(const std::string& event_type,
                                          const std::string& payload_json, long long at_ms) {
  json root;
  root["event"] = event_type;
  if (at_ms > 0) root["at"] = at_ms;
  try {
    root["payload"] = json::parse(payload_json);
  } catch (...) {
    root["payload"] = json::object();
  }
  return json_dump_safe(root);
}

}  // namespace omega::engine
