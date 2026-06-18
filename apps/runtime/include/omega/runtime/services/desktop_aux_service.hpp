#pragma once

#include "omega/runtime/event_bus.hpp"

#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

/** Browser, companion, avatar monitor, screen snip, voice — native HTTP without Electron windows. */
class DesktopAuxService {
 public:
  nlohmann::json browser_status() const;
  nlohmann::json browser_show(const nlohmann::json& opts, EventBus& events);
  nlohmann::json browser_hide(EventBus& events);
  nlohmann::json browser_navigate(const std::string& url, EventBus& events);
  nlohmann::json browser_back();
  nlohmann::json browser_forward();
  nlohmann::json browser_reload();
  nlohmann::json browser_media_command(const nlohmann::json& cmd);
  nlohmann::json browser_set_bounds(const nlohmann::json& bounds);
  nlohmann::json reopen_session_video(const nlohmann::json& body);

  nlohmann::json companion_get_active_chat() const;
  nlohmann::json companion_set_active_chat(const nlohmann::json& state);
  nlohmann::json companion_send_to_main(const nlohmann::json& payload, EventBus& events);
  nlohmann::json companion_reply_broadcast(const nlohmann::json& payload, EventBus& events);

  nlohmann::json avatar_get_enabled() const;
  nlohmann::json avatar_set_enabled(const nlohmann::json& body, EventBus& events);
  nlohmann::json avatar_set_overlay_visible(const nlohmann::json& body) const;
  nlohmann::json avatar_signals(const nlohmann::json& signals, EventBus& events);
  nlohmann::json avatar_sync_layout(const nlohmann::json& layout, EventBus& events);
  nlohmann::json avatar_restore_main();

  nlohmann::json screen_snip_init(EventBus& events);
  nlohmann::json screen_snip_get_bounds() const;
  nlohmann::json screen_snip_capture();
  nlohmann::json screen_snip_submit(const nlohmann::json& rect);
  nlohmann::json screen_snip_cancel();
  nlohmann::json screen_snip_save(const nlohmann::json& body);

  nlohmann::json voice_speak(const nlohmann::json& body, EventBus& events);

 private:
  static nlohmann::json shell_hint();

  mutable std::mutex mu_;
  nlohmann::json browser_;
  nlohmann::json companion_active_;
  bool avatar_enabled_{false};
  nlohmann::json avatar_layout_;
  nlohmann::json snip_bounds_;
};

}  // namespace omega::runtime
