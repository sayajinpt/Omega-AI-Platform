#include "omega/runtime/shell_bridge.hpp"

#include <httplib.h>

#include <cstdlib>
#include <optional>
#include <stdexcept>

namespace omega::runtime {

namespace {

std::string shell_base_url() {
  const char* env = std::getenv("OMEGA_SHELL_URL");
  if (env && *env) return env;
  return "http://127.0.0.1:9878";
}

}  // namespace

bool ShellBridge::available() const {
  httplib::Client cli(shell_base_url());
  cli.set_connection_timeout(1, 0);
  cli.set_read_timeout(1, 0);
  const auto res = cli.Get("/healthz");
  return res && res->status == 200;
}

std::optional<nlohmann::json> ShellBridge::get(const std::string& path) const {
  httplib::Client cli(shell_base_url());
  cli.set_connection_timeout(2, 0);
  cli.set_read_timeout(10, 0);
  const auto res = cli.Get(path.c_str());
  if (!res || res->status >= 400) return std::nullopt;
  if (res->body.empty()) return nlohmann::json::object();
  try {
    return nlohmann::json::parse(res->body);
  } catch (...) {
    return std::nullopt;
  }
}

std::optional<nlohmann::json> ShellBridge::post(const std::string& path,
                                                const nlohmann::json& body) const {
  httplib::Client cli(shell_base_url());
  cli.set_connection_timeout(2, 0);
  cli.set_read_timeout(120, 0);
  const auto res = cli.Post(path.c_str(), body.dump(), "application/json");
  if (!res || res->status >= 400) return std::nullopt;
  if (res->body.empty()) return nlohmann::json::object();
  try {
    return nlohmann::json::parse(res->body);
  } catch (...) {
    return std::nullopt;
  }
}

nlohmann::json ShellBridge::post_or_throw(const std::string& path,
                                          const nlohmann::json& body) const {
  if (const auto parsed = post(path, body)) return *parsed;
  throw std::runtime_error("Electron shell unavailable at " + shell_base_url() + path);
}

}  // namespace omega::runtime
