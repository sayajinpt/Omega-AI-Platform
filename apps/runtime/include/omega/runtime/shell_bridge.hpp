#pragma once

#include <nlohmann/json.hpp>

#include <optional>
#include <string>

namespace omega::runtime {

/** Forwards desktop UI requests to the Electron shell HTTP server (:9878). */
class ShellBridge {
 public:
  bool available() const;
  std::optional<nlohmann::json> get(const std::string& path) const;
  std::optional<nlohmann::json> post(const std::string& path, const nlohmann::json& body) const;
  nlohmann::json post_or_throw(const std::string& path, const nlohmann::json& body) const;
};

}  // namespace omega::runtime
