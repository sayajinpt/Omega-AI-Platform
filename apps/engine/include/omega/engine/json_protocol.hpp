#pragma once

#include <optional>
#include <string>

#include "omega/engine/command.hpp"

namespace omega::engine {

/** Parse / serialize engine-protocol JSON envelopes. */
class JsonProtocol {
 public:
  static std::optional<Command> parse_request(const std::string& line);
  static std::string serialize_response(const CommandResponse& resp);
  static std::string serialize_event(const Event& event);
  static std::string serialize_event(const std::string& event_type, const std::string& payload_json,
                                     long long at_ms = 0);
};

}  // namespace omega::engine
