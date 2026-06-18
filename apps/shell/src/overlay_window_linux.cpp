#include "omega/shell/overlay_window.hpp"

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

#include <string>

namespace omega::shell {

struct OverlayWindow::Impl {
  GtkWidget* window{nullptr};
  WebKitWebView* webview{nullptr};
};

OverlayWindow::OverlayWindow() : impl_(new Impl) {}
OverlayWindow::~OverlayWindow() {
  hide();
  if (impl_->window) {
    gtk_widget_destroy(impl_->window);
    impl_->window = nullptr;
    impl_->webview = nullptr;
  }
  delete impl_;
  impl_ = nullptr;
}

void OverlayWindow::show(const std::string& url, int x, int y, int width, int height) {
  visible_ = true;
  if (!impl_->window) {
    impl_->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_decorated(GTK_WINDOW(impl_->window), FALSE);
    gtk_window_set_keep_above(GTK_WINDOW(impl_->window), TRUE);
    impl_->webview = WEBKIT_WEB_VIEW(webkit_web_view_new());
    gtk_container_add(GTK_CONTAINER(impl_->window), GTK_WIDGET(impl_->webview));
  }
  gtk_window_move(GTK_WINDOW(impl_->window), x, y);
  gtk_window_resize(GTK_WINDOW(impl_->window), width, height);
  webkit_web_view_load_uri(impl_->webview, url.c_str());
  gtk_widget_show_all(impl_->window);
}

void OverlayWindow::hide() {
  visible_ = false;
  if (impl_->window) gtk_widget_hide(impl_->window);
}

void OverlayWindow::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  std::string payload = json_payload.empty() ? "null" : json_payload;
  std::string js = "window.postMessage({type:'omega-shell-event',channel:'" + channel +
                   "',payload:" + payload + "}, '*');";
  webkit_web_view_run_javascript(impl_->webview, js.c_str(), nullptr, nullptr, nullptr);
}

}  // namespace omega::shell
