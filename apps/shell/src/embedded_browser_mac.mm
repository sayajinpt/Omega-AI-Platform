#include "omega/shell/embedded_browser.hpp"

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <string>

namespace omega::shell {

struct EmbeddedBrowser::Impl {
  NSView* parent{nil};
  WKWebView* webview{nil};
};

EmbeddedBrowser::EmbeddedBrowser() : impl_(new Impl) {}
EmbeddedBrowser::~EmbeddedBrowser() {
  if (impl_->webview) {
    [impl_->webview removeFromSuperview];
    impl_->webview = nil;
  }
  delete impl_;
  impl_ = nullptr;
}

void EmbeddedBrowser::attach(NativeWindow parent) { impl_->parent = (__bridge NSView*)parent; }

void EmbeddedBrowser::show(const BrowserBounds& bounds) {
  bounds_ = bounds;
  visible_ = true;
  if (!impl_->parent) return;
  if (!impl_->webview) {
    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    impl_->webview = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:config];
    [impl_->parent addSubview:impl_->webview];
  }
  impl_->webview.hidden = NO;
  set_bounds(bounds_);
}

void EmbeddedBrowser::hide() {
  visible_ = false;
  if (impl_->webview) impl_->webview.hidden = YES;
}

void EmbeddedBrowser::ensure_shown() {
  if (!visible_) show(bounds_);
}

void EmbeddedBrowser::set_bounds(const BrowserBounds& bounds) {
  bounds_ = bounds;
  if (!impl_->webview) return;
  impl_->webview.frame =
      NSMakeRect(bounds.x, impl_->parent.bounds.size.height - bounds.y - bounds.height, bounds.width,
                 bounds.height);
}

bool EmbeddedBrowser::navigate(const std::string& url) {
  if (!impl_->webview) show(bounds_);
  NSString* nsurl = [[NSString alloc] initWithBytes:url.data() length:url.size()
                                           encoding:NSUTF8StringEncoding];
  NSURL* target = [NSURL URLWithString:nsurl];
  if (!target) return false;
  [impl_->webview loadRequest:[NSURLRequest requestWithURL:target]];
  visible_ = true;
  return true;
}

bool EmbeddedBrowser::back() {
  if (!impl_->webview || ![impl_->webview canGoBack]) return false;
  [impl_->webview goBack];
  return true;
}

bool EmbeddedBrowser::forward() {
  if (!impl_->webview || ![impl_->webview canGoForward]) return false;
  [impl_->webview goForward];
  return true;
}

bool EmbeddedBrowser::reload() {
  if (!impl_->webview) return false;
  [impl_->webview reload];
  return true;
}

std::string EmbeddedBrowser::current_url() const {
  if (!impl_->webview || !impl_->webview.URL) return {};
  return std::string([[impl_->webview.URL absoluteString] UTF8String]);
}

}  // namespace omega::shell
