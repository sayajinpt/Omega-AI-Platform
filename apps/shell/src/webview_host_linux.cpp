#include "omega/shell/webview_host.hpp"

#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

#include <string>

namespace omega::shell {

namespace {

std::string shell_event_js(const std::string& channel, const std::string& json_payload) {
  std::string payload = json_payload.empty() ? "null" : json_payload;
  return "window.postMessage({type:'omega-shell-event',channel:'" + channel + "',payload:" +
         payload + "}, '*');";
}

}  // namespace

struct WebViewHost::Impl {
  GtkWidget* container{nullptr};
  WebKitWebView* webview{nullptr};
};

WebViewHost::WebViewHost() : impl_(new Impl) {}
WebViewHost::~WebViewHost() {
  if (impl_->container) {
    gtk_widget_destroy(impl_->container);
    impl_->container = nullptr;
    impl_->webview = nullptr;
  }
  delete impl_;
  impl_ = nullptr;
}

bool WebViewHost::create(NativeWindow parent, const std::string& initial_url, ReadyCallback on_ready) {
  GtkWidget* parent_widget = static_cast<GtkWidget*>(parent);
  if (!parent_widget) return false;

  impl_->container = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  impl_->webview = WEBKIT_WEB_VIEW(webkit_web_view_new());
  gtk_box_pack_start(GTK_BOX(impl_->container), GTK_WIDGET(impl_->webview), TRUE, TRUE, 0);
  gtk_container_add(GTK_CONTAINER(parent_widget), impl_->container);
  gtk_widget_show_all(impl_->container);

  webkit_web_view_load_uri(impl_->webview, initial_url.c_str());
  if (on_ready) on_ready();
  return true;
}

void WebViewHost::resize(int width, int height) {
  if (!impl_->container) return;
  gtk_widget_set_size_request(impl_->container, width, height);
}

void WebViewHost::navigate(const std::string& url) {
  if (!impl_->webview) return;
  webkit_web_view_load_uri(impl_->webview, url.c_str());
}

void WebViewHost::focus_host_window() {
  if (!impl_->container) return;
  GtkWidget* toplevel = gtk_widget_get_toplevel(impl_->container);
  if (GTK_IS_WINDOW(toplevel)) {
    gtk_window_present(GTK_WINDOW(toplevel));
  }
}

void WebViewHost::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  const std::string js = shell_event_js(channel, json_payload);
  webkit_web_view_run_javascript(impl_->webview, js.c_str(), nullptr, nullptr, nullptr);
}

void WebViewHost::exec_editing_command(const char* command) {
  if (!impl_->webview || !command || !*command) return;
  std::string js = std::string("document.execCommand('") + command + "')";
  webkit_web_view_run_javascript(impl_->webview, js.c_str(), nullptr, nullptr, nullptr);
}

}  // namespace omega::shell
