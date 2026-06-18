#include "omega/shell/overlay_window.hpp"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <string>

namespace omega::shell {

struct OverlayWindow::Impl {
  NSWindow* window{nil};
  WKWebView* webview{nil};
};

OverlayWindow::OverlayWindow() : impl_(new Impl) {}
OverlayWindow::~OverlayWindow() {
  hide();
  delete impl_;
  impl_ = nullptr;
}

void OverlayWindow::show(const std::string& url, int x, int y, int width, int height) {
  visible_ = true;
  if (!impl_->window) {
    impl_->window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(x, y, width, height)
                  styleMask:NSWindowStyleMaskBorderless
                    backing:NSBackingStoreBuffered
                      defer:NO];
    [impl_->window setLevel:NSFloatingWindowLevel];
    [impl_->window setOpaque:NO];
    [impl_->window setBackgroundColor:[NSColor clearColor]];
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    impl_->webview = [[WKWebView alloc] initWithFrame:impl_->window.contentView.bounds
                                        configuration:config];
    impl_->webview.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    impl_->window.contentView = impl_->webview;
  }
  [impl_->window setFrame:NSMakeRect(x, y, width, height) display:YES];
  NSString* nsurl = [[NSString alloc] initWithBytes:url.data() length:url.size()
                                           encoding:NSUTF8StringEncoding];
  [impl_->webview loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:nsurl]]];
  [impl_->window orderFrontRegardless];
}

void OverlayWindow::hide() {
  visible_ = false;
  if (impl_->window) [impl_->window orderOut:nil];
}

void OverlayWindow::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  std::string payload = json_payload.empty() ? "null" : json_payload;
  std::string js = "window.postMessage({type:'omega-shell-event',channel:'" + channel +
                   "',payload:" + payload + "}, '*');";
  NSString* script = [[NSString alloc] initWithBytes:js.data() length:js.size()
                                            encoding:NSUTF8StringEncoding];
  [impl_->webview evaluateJavaScript:script completionHandler:nil];
}

}  // namespace omega::shell
