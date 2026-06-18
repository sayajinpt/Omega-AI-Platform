#pragma once

#include "omega/shell/platform_window.hpp"

#include <string>

namespace omega::shell {

struct BrowserBounds {
  int x{0};
  int y{0};
  int width{800};
  int height{600};
};

/** Embedded browser overlay on the main window. */
class EmbeddedBrowser {
 public:
  EmbeddedBrowser();
  ~EmbeddedBrowser();

  void attach(NativeWindow parent);
  void show(const BrowserBounds& bounds);
  void hide();
  void set_bounds(const BrowserBounds& bounds);
  bool navigate(const std::string& url);
  bool back();
  bool forward();
  bool reload();

  std::string current_url() const;
  std::string document_title() const;
  bool loading() const { return loading_; }
  bool can_go_back() const;
  bool can_go_forward() const;
  bool webview_ready() const;
  bool visible() const { return visible_; }
  /** Show using the last bounds from {@link show} if currently hidden. */
  void ensure_shown();
  /** pause | resume | stop — runs JS in the active WebView2 document (YouTube/video). */
  bool media_command(const std::string& action);

 private:
  void apply_pending_navigation();
  void wire_webview_events();

  struct Impl;
  Impl* impl_{nullptr};
  bool visible_{false};
  bool loading_{false};
  std::string page_title_;
  BrowserBounds bounds_{};
  std::string pending_url_;
};

}  // namespace omega::shell
