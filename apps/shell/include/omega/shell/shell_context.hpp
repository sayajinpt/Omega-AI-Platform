#pragma once

#include "omega/shell/platform_window.hpp"
#include "omega/shell/webview_host.hpp"

#include <memory>
#include <string>

namespace omega::shell {

class EmbeddedBrowser;
class OverlayWindow;
class ShellHttpServer;
class ScreenSnipService;

/** Shared desktop integration state for omega-desktop. */
struct ShellContext {
  NativeWindow main_window{nullptr};
  WebViewHost* main_webview{nullptr};
  int ui_port{9777};
  std::string runtime_base{"http://127.0.0.1:9877"};

  std::unique_ptr<EmbeddedBrowser> browser;
  std::unique_ptr<OverlayWindow> avatar_overlay;
  std::unique_ptr<OverlayWindow> sniper_overlay;
  std::unique_ptr<ScreenSnipService> screen_snip;
  std::unique_ptr<ShellHttpServer> shell_http;

  ShellContext();
  ~ShellContext();

  std::string ui_page_url(const char* page) const;
};

ShellContext& shell_context();

}  // namespace omega::shell
