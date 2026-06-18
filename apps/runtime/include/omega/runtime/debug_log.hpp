#pragma once

#include "omega/runtime/services/debug_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Write one line to the in-app Debug panel (omega:debug:event). No-op if store is null. */
inline void emit_debug(DebugStore* store, const std::string& source, const std::string& message,
                       const std::string& level = "info",
                       const nlohmann::json& data = nlohmann::json::object()) {
  if (!store) return;
  store->log(source, message, level, data.is_null() ? nlohmann::json::object() : data);
}

}  // namespace omega::runtime
