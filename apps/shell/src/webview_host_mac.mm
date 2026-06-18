#include "omega/shell/webview_host.hpp"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <string>

namespace omega::shell {

namespace {

NSString* to_ns(const std::string& s) {
  return [[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding];
}

std::string shell_event_js(const std::string& channel, const std::string& json_payload) {
  std::string payload = json_payload.empty() ? "null" : json_payload;
  return "window.postMessage({type:'omega-shell-event',channel:" + std::string("'") + channel +
         "',payload:" + payload + "}, '*');";
}

}  // namespace

struct WebViewHost::Impl {
  NSView* parent{nil};
  WKWebView* webview{nil};
};

WebViewHost::WebViewHost() : impl_(new Impl) {}
WebViewHost::~WebViewHost() {
  if (impl_->webview) {
    [impl_->webview removeFromSuperview];
    impl_->webview = nil;
  }
  delete impl_;
  impl_ = nullptr;
}

bool WebViewHost::create(NativeWindow parent, const std::string& initial_url, ReadyCallback on_ready) {
  impl_->parent = (__bridge NSView*)parent;
  if (!impl_->parent) return false;

  WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
  config.preferences.javaScriptEnabled = YES;
  impl_->webview = [[WKWebView alloc] initWithFrame:impl_->parent.bounds configuration:config];
  impl_->webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  impl_->webview.translatesAutoresizingMaskIntoConstraints = YES;
  [impl_->parent addSubview:impl_->webview positioned:NSWindowBelow relativeTo:nil];

  NSURL* url = [NSURL URLWithString:to_ns(initial_url)];
  if (url) {
    [impl_->webview loadRequest:[NSURLRequest requestWithURL:url]];
  }
  if (on_ready) on_ready();
  return true;
}

void WebViewHost::resize(int width, int height) {
  if (!impl_->webview) return;
  impl_->webview.frame = NSMakeRect(0, 0, width, height);
}

void WebViewHost::navigate(const std::string& url) {
  if (!impl_->webview) return;
  NSURL* nsurl = [NSURL URLWithString:to_ns(url)];
  if (!nsurl) return;
  [impl_->webview loadRequest:[NSURLRequest requestWithURL:nsurl]];
}

void WebViewHost::focus_host_window() {
  if (!impl_->parent) return;
  NSWindow* window = impl_->parent.window;
  if (!window) return;
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

void WebViewHost::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  const std::string js = shell_event_js(channel, json_payload);
  [impl_->webview evaluateJavaScript:to_ns(js) completionHandler:nil];
}

void WebViewHost::exec_editing_command(const char* command) {
  if (!impl_->webview || !command || !*command) return;
  std::string js = std::string("document.execCommand('") + command + "')";
  [impl_->webview evaluateJavaScript:to_ns(js) completionHandler:nil];
}

}  // namespace omega::shell
