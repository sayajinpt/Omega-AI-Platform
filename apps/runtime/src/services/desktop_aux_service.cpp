#include "omega/runtime/services/desktop_aux_service.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/shell_bridge.hpp"

#include <filesystem>
#include <fstream>
#include <cstdlib>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sapi.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

ShellBridge g_shell;

fs::path aux_state_path() { return fs::path(omega_home()) / "desktop-aux.json"; }

std::string shell_quote(const std::string& s) {
#ifdef _WIN32
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += "\"";
  return out;
#else
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
#endif
}

}  // namespace

std::string normalize_browser_url(std::string url) {
  while (!url.empty() && (url.front() == ' ' || url.front() == '\t')) url.erase(url.begin());
  while (!url.empty() && (url.back() == ' ' || url.back() == '\t')) url.pop_back();
  if (url.empty()) return url;
  const auto scheme = url.find("://");
  if (scheme != std::string::npos && scheme > 0) return url;
  if (url.starts_with("//")) return "https:" + url;
  return "https://" + url;
}

json normalize_avatar_set_enabled_body(const json& body) {
  if (body.is_boolean()) return json{{"enabled", body.get<bool>()}};
  if (body.is_array() && !body.empty()) {
    json out{{"enabled", body[0].get<bool>()}};
    if (body.size() > 1 && body[1].is_object()) out["state"] = body[1];
    return out;
  }
  return body;
}

json DesktopAuxService::shell_hint() {
  const bool shell_up = g_shell.available();
  return json{{"embeddedBrowser", shell_up},
              {"overlayWindows", shell_up},
              {"shellUrl", shell_up ? "http://127.0.0.1:9878" : ""},
              {"hint", shell_up ? "" : "Omega desktop shell not reachable — start omega-desktop for embedded browser and overlays."}};
}

json DesktopAuxService::browser_status() const {
  std::lock_guard lock(mu_);
  json out = browser_;
  const bool shell_up = g_shell.available();
  out["embeddedAvailable"] = shell_up;
  if (shell_up) {
    if (const auto shell = g_shell.get("/v1/shell/browser/status")) {
      out.merge_patch(*shell);
      out["visible"] = shell->value("visible", out.value("visible", false));
    }
  }
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_show(const json& opts, EventBus& events) {
  json shell_body = opts;
  if (opts.is_object() && opts.contains("x") && opts.contains("width") && !opts.contains("bounds")) {
    shell_body = json{{"bounds", opts}};
  }
  if (const auto shell = g_shell.post("/v1/shell/browser/show", shell_body)) {
    events.publish("omega:browser:status", browser_status());
    json out = *shell;
    out["opened"] = true;
    return out;
  }
  {
    std::lock_guard lock(mu_);
    browser_["visible"] = true;
    if (opts.contains("url") && opts["url"].is_string()) browser_["url"] = opts["url"];
    browser_["canGoBack"] = false;
    browser_["canGoForward"] = false;
  }
  events.publish("omega:browser:hidden", json{{"visible", true}});
  json out = browser_status();
  out["opened"] = false;
  return out;
}

json DesktopAuxService::browser_hide(EventBus& events) {
  browser_media_command(json{{"action", "stop"}});
  if (g_shell.post("/v1/shell/browser/hide", json::object())) {
    {
      std::lock_guard lock(mu_);
      browser_["visible"] = false;
    }
    events.publish("omega:browser:hidden", json{{"visible", false}});
    return browser_status();
  }
  {
    std::lock_guard lock(mu_);
    browser_["visible"] = false;
  }
  events.publish("omega:browser:hidden", json{{"visible", false}});
  return browser_status();
}

json DesktopAuxService::browser_navigate(const std::string& url, EventBus& events) {
  const std::string normalized = normalize_browser_url(url);
  if (normalized.empty()) throw std::runtime_error("url required");
  if (const auto shell = g_shell.post("/v1/shell/browser/navigate", json{{"url", normalized}})) {
    {
      std::lock_guard lock(mu_);
      browser_["url"] = shell->value("url", normalized);
      browser_["visible"] = true;
      if (shell->contains("title")) browser_["title"] = (*shell)["title"];
      if (shell->contains("loading")) browser_["loading"] = (*shell)["loading"];
      if (shell->contains("canGoBack")) browser_["canGoBack"] = (*shell)["canGoBack"];
      if (shell->contains("canGoForward")) browser_["canGoForward"] = (*shell)["canGoForward"];
    }
    events.publish("omega:browser:status", browser_status());
    json out = browser_status();
    out["opened"] = shell->value("opened", true);
    return out;
  }
  {
    std::lock_guard lock(mu_);
    browser_["url"] = normalized;
    browser_["visible"] = true;
  }
  events.publish("omega:browser:hidden", json{{"visible", true}, {"url", normalized}});
  json out = json{{"url", normalized}, {"opened", false}, {"pageUrl", normalized}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_back() {
  if (g_shell.post("/v1/shell/browser/back", json::object())) {
    return browser_status();
  }
  json out = json{{"ok", false}, {"reason", "no embedded browser history"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_forward() {
  if (g_shell.post("/v1/shell/browser/forward", json::object())) {
    return browser_status();
  }
  json out = json{{"ok", false}, {"reason", "no embedded browser history"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_reload() {
  if (g_shell.post("/v1/shell/browser/reload", json::object())) {
    return browser_status();
  }
  std::string url;
  {
    std::lock_guard lock(mu_);
    url = browser_.value("url", "");
  }
  json out = json{{"url", url}, {"reloaded", false}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_media_command(const json& cmd) {
  const std::string action = cmd.value("action", "");
  if (action.empty()) {
    json out = json{{"ok", false}, {"reason", "action required"}};
    out.merge_patch(shell_hint());
    return out;
  }
  if (const auto shell = g_shell.post("/v1/shell/browser/mediaCommand", cmd)) {
    json out = *shell;
    if (!out.contains("ok")) out["ok"] = true;
    return out;
  }
  json out = json{{"ok", false}, {"command", cmd}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::browser_set_bounds(const json& body) {
  json bounds = body;
  if (body.is_object() && body.contains("bounds") && body["bounds"].is_object()) {
    bounds = body["bounds"];
  }
  if (const auto shell = g_shell.post("/v1/shell/browser/setBounds", json{{"bounds", bounds}})) {
    {
      std::lock_guard lock(mu_);
      browser_["bounds"] = bounds;
    }
    json out = *shell;
    out["applied"] = true;
    return out;
  }
  {
    std::lock_guard lock(mu_);
    browser_["bounds"] = bounds;
  }
  json out = json{{"bounds", bounds}, {"applied", false}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::reopen_session_video(const json& body) {
  if (const auto shell = g_shell.post("/v1/shell/media/reopenSessionVideo", body)) {
    return *shell;
  }
  json out = json{{"ok", false}, {"reason", "desktop shell not reachable"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::companion_get_active_chat() const {
  std::lock_guard lock(mu_);
  if (companion_active_.is_null() || !companion_active_.is_object()) {
    return json{{"sessionId", nullptr}, {"modelId", ""}, {"systemPrompt", ""}};
  }
  return companion_active_;
}

json DesktopAuxService::companion_set_active_chat(const json& state) {
  std::lock_guard lock(mu_);
  companion_active_ = json{{"sessionId", state.value("sessionId", json())},
                           {"modelId", state.value("modelId", "")},
                           {"systemPrompt", state.value("systemPrompt", "")}};
  return companion_active_;
}

json DesktopAuxService::companion_send_to_main(const json& payload, EventBus& events) {
  const std::string text = payload.value("text", "");
  if (text.empty() && (!payload.contains("attachments") || !payload["attachments"].is_array() ||
                       payload["attachments"].empty())) {
    return json{{"ok", false}, {"error", "Empty message"}};
  }
  // Detached companion → main chat: deliver via runtime event bus (main window HTTP poll).
  // Do not rely on shell PostWebMessage alone — that path must run on the UI thread and
  // previously skipped the bus when shell returned ok, so messages were lost.
  events.publish("omega:companion:send-deliver", payload);
  if (g_shell.available()) {
    g_shell.post("/v1/shell/avatar-monitor/restore-main", json::object());
  }
  return json{{"ok", true}, {"deliveredVia", "event_bus"}};
}

json DesktopAuxService::companion_reply_broadcast(const json& payload, EventBus& events) {
  events.publish("omega:companion:reply-deliver", payload);
  return json{{"ok", true}};
}

json DesktopAuxService::avatar_get_enabled() const {
  std::lock_guard lock(mu_);
  json out = json{{"enabled", avatar_enabled_}, {"layout", avatar_layout_}};
  if (const auto shell = g_shell.get("/v1/shell/avatar-monitor/status")) {
    out.merge_patch(*shell);
  }
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::avatar_set_overlay_visible(const nlohmann::json& body) const {
  if (const auto shell = g_shell.post("/v1/shell/avatar-monitor/set-overlay-visible", body)) {
    return *shell;
  }
  json out = json{{"ok", false}, {"overlayVisible", false}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::avatar_set_enabled(const json& body, EventBus& events) {
  const json req = normalize_avatar_set_enabled_body(body);
  if (const auto shell = g_shell.post("/v1/shell/avatar-monitor/set-enabled", req)) {
    const bool enabled = req.value("enabled", false);
    {
      std::lock_guard lock(mu_);
      avatar_enabled_ = enabled;
      if (req.contains("state") && req["state"].is_object()) avatar_layout_ = req["state"];
    }
    events.publish("omega:avatar-monitor:enabled", json{{"enabled", enabled}});
    return *shell;
  }
  const bool enabled = req.value("enabled", req.is_boolean() ? req.get<bool>() : false);
  if (enabled) {
    json out = json{{"enabled", false},
                    {"error", "Shell overlay unavailable (omega-shell not running on port 9878)"}};
    out.merge_patch(shell_hint());
    return out;
  }
  json layout_copy;
  {
    std::lock_guard lock(mu_);
    avatar_enabled_ = false;
    layout_copy = avatar_layout_;
  }
  events.publish("omega:avatar-monitor:enabled", json{{"enabled", false}});
  if (!layout_copy.is_null()) events.publish("omega:avatar-monitor:layout", layout_copy);
  json out = json{{"enabled", false}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::avatar_signals(const json& signals, EventBus& events) {
  events.publish("omega:avatar-monitor:signals", signals);
  return json{{"ok", true}};
}

json DesktopAuxService::avatar_sync_layout(const json& layout, EventBus& events) {
  {
    std::lock_guard lock(mu_);
    avatar_layout_ = layout;
  }
  events.publish("omega:avatar-monitor:layout", layout);
  json out = json{{"layout", layout}, {"applied", false}};
  bool detached = false;
  {
    std::lock_guard lock(mu_);
    detached = avatar_enabled_;
  }
  if (detached) {
    if (const auto shell = g_shell.post("/v1/shell/avatar-monitor/sync-layout", layout)) {
      out["applied"] = shell->value("applied", true);
    }
  }
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::avatar_restore_main() {
  if (const auto shell = g_shell.post("/v1/shell/avatar-monitor/restore-main", json::object())) {
    return *shell;
  }
  json out = json{{"focused", false}, {"reason", "no main Electron window in native runtime"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::screen_snip_init(EventBus& events) {
  if (const auto shell = g_shell.get("/v1/shell/screen-snip/bounds")) {
    snip_bounds_ = shell->value("bounds", json::object());
  } else {
    snip_bounds_ = json{{"x", 0}, {"y", 0}, {"width", 1920}, {"height", 1080}};
  }
  events.publish("omega:screen-snip:init", snip_bounds_);
  json out = json{{"bounds", snip_bounds_}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::screen_snip_get_bounds() const {
  if (const auto shell = g_shell.get("/v1/shell/screen-snip/bounds")) {
    return shell->value("bounds", json::object());
  }
  if (!snip_bounds_.is_null()) return snip_bounds_;
  return json{{"x", 0}, {"y", 0}, {"width", 1920}, {"height", 1080}};
}

json DesktopAuxService::screen_snip_capture() {
  if (const auto shell = g_shell.post("/v1/shell/screen-snip/capture", json::object())) {
    return *shell;
  }
  return json{{"capture", json()}};
}

json DesktopAuxService::screen_snip_submit(const json& rect) {
  if (const auto shell = g_shell.post("/v1/shell/screen-snip/submit", rect)) {
    return *shell;
  }
  json out{{"ok", false},
           {"reason",
            "Screen capture requires omega-desktop — attach an image via POST "
            "/v1/chat/stage-attachment instead"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::screen_snip_cancel() {
  if (const auto shell = g_shell.post("/v1/shell/screen-snip/cancel", json::object())) {
    return *shell;
  }
  return json{{"cancelled", true}};
}

json DesktopAuxService::screen_snip_save(const json& body) {
  if (const auto shell = g_shell.post("/v1/shell/screen-snip/save", body)) {
    return *shell;
  }
  json out{{"ok", false}, {"reason", "Screen snip save requires omega-desktop shell"}};
  out.merge_patch(shell_hint());
  return out;
}

json DesktopAuxService::voice_speak(const json& body, EventBus& events) {
  const std::string text = body.value("text", "");
  events.publish("omega:voice:speak", body);
  if (text.empty()) return json{{"spoken", false}, {"text", text}, {"reason", "text required"}};

#ifdef _WIN32
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool com_ok = SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE;
  bool spoken = false;
  if (com_ok) {
    ISpVoice* voice = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_SpVoice, nullptr, CLSCTX_ALL, IID_ISpVoice,
                                   reinterpret_cast<void**>(&voice))) &&
        voice) {
      std::wstring wtext;
      const int wlen = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
      if (wlen > 0) {
        wtext.resize(static_cast<size_t>(wlen - 1));
        MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, wtext.data(), wlen);
      }
      if (!wtext.empty()) {
        const HRESULT speak_hr = voice->Speak(wtext.c_str(), SPF_ASYNC, nullptr);
        spoken = SUCCEEDED(speak_hr);
      }
      voice->Release();
    }
    if (SUCCEEDED(hr)) CoUninitialize();
  }
  return json{{"spoken", spoken}, {"text", text}, {"engine", spoken ? "sapi" : "unavailable"}};
#elif defined(__APPLE__)
  const std::string cmd = "say " + shell_quote(text) + " >/dev/null 2>&1 &";
  const bool spoken = std::system(cmd.c_str()) == 0;
  return json{{"spoken", spoken}, {"text", text}, {"engine", "say"}};
#elif defined(__linux__)
  bool spoken = std::system(("spd-say " + shell_quote(text) + " 2>/dev/null").c_str()) == 0;
  if (!spoken) {
    spoken = std::system(("espeak " + shell_quote(text) + " 2>/dev/null").c_str()) == 0;
  }
  return json{{"spoken", spoken},
              {"text", text},
              {"engine", spoken ? "spd-say/espeak" : "unavailable"}};
#else
  return json{{"spoken", false}, {"text", text}, {"hint", "TTS not implemented on this platform yet"}};
#endif
}

}  // namespace omega::runtime
