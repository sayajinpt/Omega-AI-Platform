#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

inline std::string json_dump_safe(const nlohmann::json& j) {
  return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
}

}  // namespace omega::runtime
