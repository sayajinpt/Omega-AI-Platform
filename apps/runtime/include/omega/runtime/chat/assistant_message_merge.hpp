#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

struct AssistantMessagePayload {
  std::string content;
  nlohmann::json extras = nlohmann::json::object();
};

/** Merge prose with tool outputs (choices fences, structured parts) for SQLite + UI. */
AssistantMessagePayload build_assistant_payload(const std::string& prose,
                                                const std::vector<nlohmann::json>& tool_results);

}  // namespace omega::runtime
