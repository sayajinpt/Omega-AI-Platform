#include "omega/shell/platform_window.hpp"

#import <Cocoa/Cocoa.h>

namespace omega::shell {

bool open_url_in_browser(const std::string& url) {
  if (url.empty()) return false;
  NSString* nsurl = [[NSString alloc] initWithBytes:url.data() length:url.size()
                                           encoding:NSUTF8StringEncoding];
  NSURL* target = [NSURL URLWithString:nsurl];
  if (!target) return false;
  return [[NSWorkspace sharedWorkspace] openURL:target];
}

void show_main_window(NativeWindow window) {
  NSView* view = (__bridge NSView*)window;
  NSWindow* win = view.window;
  if (!win) return;
  [win makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

void hide_main_window(NativeWindow window) {
  NSView* view = (__bridge NSView*)window;
  if (view.window) [view.window orderOut:nil];
}

void focus_main_window(NativeWindow window) { show_main_window(window); }

}  // namespace omega::shell
