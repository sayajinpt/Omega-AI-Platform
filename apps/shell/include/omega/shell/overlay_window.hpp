#pragma once

#include <functional>
#include <string>

#ifdef _WIN32
struct HWND__;
typedef HWND__* HWND;
#endif

namespace omega::shell {

/** Frameless always-on-top web overlay (avatar monitor, etc.). */
class OverlayWindow {
 public:
  OverlayWindow();
  ~OverlayWindow();

  void show(const std::string& url, int x, int y, int width, int height);
  void hide();
  /** Hide and destroy HWND/WebView so the next show starts clean. */
  void teardown();
  void post_shell_event(const std::string& channel, const std::string& json_payload);
  bool visible() const { return visible_; }
#ifdef _WIN32
  HWND hwnd() const;
#endif
  /** Fired when the user closes the overlay (X / Alt+F4), after hide(). */
  void set_close_handler(std::function<void()> handler);
  /** Called from the Win32 window procedure when the user dismisses the overlay. */
  void user_closed();

 private:

  struct Impl;
  Impl* impl_{nullptr};
  bool visible_{false};
  std::function<void()> on_close_;
};

}  // namespace omega::shell
