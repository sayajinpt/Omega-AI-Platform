#include "omega/shell/embedded_browser.hpp"

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

#include <string>

namespace omega::shell {

struct EmbeddedBrowser::Impl {
  GtkWidget* parent{nullptr};
  WebKitWebView* webview{nullptr};
  GtkWidget* container{nullptr};
};

EmbeddedBrowser::EmbeddedBrowser() : impl_(new Impl) {}
EmbeddedBrowser::~EmbeddedBrowser() {
  if (impl_->container) {
    gtk_widget_destroy(impl_->container);
    impl_->container = nullptr;
    impl_->webview = nullptr;
  }
  delete impl_;
  impl_ = nullptr;
}

void EmbeddedBrowser::attach(NativeWindow parent) { impl_->parent = static_cast<GtkWidget*>(parent); }

void EmbeddedBrowser::show(const BrowserBounds& bounds) {
  bounds_ = bounds;
  visible_ = true;
  if (!impl_->parent) return;
  if (!impl_->webview) {
    impl_->container = gtk_fixed_new();
    impl_->webview = WEBKIT_WEB_VIEW(webkit_web_view_new());
    gtk_fixed_put(GTK_FIXED(impl_->container), GTK_WIDGET(impl_->webview), bounds.x, bounds.y);
    gtk_widget_set_size_request(GTK_WIDGET(impl_->webview), bounds.width, bounds.height);
    gtk_container_add(GTK_CONTAINER(impl_->parent), impl_->container);
    gtk_widget_show_all(impl_->container);
  }
  gtk_widget_show(impl_->container);
  set_bounds(bounds_);
}

void EmbeddedBrowser::hide() {
  visible_ = false;
  if (impl_->container) gtk_widget_hide(impl_->container);
}

void EmbeddedBrowser::ensure_shown() {
  if (!visible_) show(bounds_);
}

void EmbeddedBrowser::set_bounds(const BrowserBounds& bounds) {
  bounds_ = bounds;
  if (!impl_->webview || !impl_->container) return;
  gtk_fixed_move(GTK_FIXED(impl_->container), GTK_WIDGET(impl_->webview), bounds.x, bounds.y);
  gtk_widget_set_size_request(GTK_WIDGET(impl_->webview), bounds.width, bounds.height);
}

bool EmbeddedBrowser::navigate(const std::string& url) {
  if (!impl_->webview) show(bounds_);
  webkit_web_view_load_uri(impl_->webview, url.c_str());
  visible_ = true;
  return true;
}

bool EmbeddedBrowser::back() {
  if (!impl_->webview) return false;
  webkit_web_view_go_back(impl_->webview);
  return true;
}

bool EmbeddedBrowser::forward() {
  if (!impl_->webview) return false;
  webkit_web_view_go_forward(impl_->webview);
  return true;
}

bool EmbeddedBrowser::reload() {
  if (!impl_->webview) return false;
  webkit_web_view_reload(impl_->webview);
  return true;
}

std::string EmbeddedBrowser::current_url() const {
  if (!impl_->webview) return {};
  const gchar* uri = webkit_web_view_get_uri(impl_->webview);
  return uri ? std::string(uri) : std::string{};
}

}  // namespace omega::shell
