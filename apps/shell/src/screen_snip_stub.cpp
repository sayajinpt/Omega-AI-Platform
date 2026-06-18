#include "omega/shell/screen_snip_service.hpp"

#include "omega/shell/shell_context.hpp"

namespace omega::shell {

ScreenSnipService::ScreenSnipService(ShellContext& ctx) : ctx_(ctx) {}
ScreenSnipService::~ScreenSnipService() = default;

nlohmann::json ScreenSnipService::capture() {
  return nlohmann::json{{"ok", false}, {"reason", "Screen snip is not implemented on this platform yet"}};
}

nlohmann::json ScreenSnipService::get_bounds() const {
  return nlohmann::json{{"x", 0}, {"y", 0}, {"width", 1920}, {"height", 1080}};
}

nlohmann::json ScreenSnipService::submit(const nlohmann::json&) {
  return nlohmann::json{{"ok", false}, {"reason", "Screen snip is not implemented on this platform yet"}};
}

nlohmann::json ScreenSnipService::cancel() { return nlohmann::json{{"cancelled", true}}; }

nlohmann::json ScreenSnipService::save(const nlohmann::json&) {
  return nlohmann::json{{"ok", false}, {"reason", "Screen snip save is not implemented on this platform yet"}};
}

}  // namespace omega::shell
