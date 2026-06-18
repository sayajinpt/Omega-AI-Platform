#pragma once

#include <string>

namespace omega::engine {

/** JSON command envelope (matches @omega/sdk EngineCommandRequest). */
struct Command {
  std::string id;
  std::string type;
  std::string payload_json;
};

/** JSON response envelope (matches @omega/sdk EngineCommandResponse). */
struct CommandResponse {
  std::string id;
  std::string type;
  bool success = false;
  std::string data_json;
  std::string error;
};

/** Push event envelope (matches @omega/sdk EngineEvent). */
struct Event {
  std::string type;
  std::string run_id;
  long long at_ms = 0;
  std::string payload_json;
};

}  // namespace omega::engine
