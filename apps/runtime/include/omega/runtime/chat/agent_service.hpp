#pragma once

#include "omega/runtime/chat/stream_hub.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/tools/tool_registry.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class AgentService {
 public:
  AgentService(EngineClient& engine, MemoryStore& memory, ToolRegistry& tools,
               StreamHub& streams);

  nlohmann::json run(const nlohmann::json& req);
  nlohmann::json abort();

 private:
  EngineClient& engine_;
  MemoryStore& memory_;
  ToolRegistry& tools_;
  StreamHub& streams_;
  std::string active_run_id_;
};

}  // namespace omega::runtime
