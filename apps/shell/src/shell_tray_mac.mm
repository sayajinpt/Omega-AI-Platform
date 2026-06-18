#include "omega/shell/shell_menu.hpp"

#include "omega/shell/app_paths.hpp"
#include "omega/shell/platform_window.hpp"

#import <Cocoa/Cocoa.h>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace omega::shell {

namespace {

NSStatusItem* g_status_item = nil;
NSWindow* g_main_window = nil;
bool g_quitting = false;
bool g_close_to_tray = true;

@interface OmegaTrayActions : NSObject
- (void)showMain:(id)sender;
- (void)quitApp:(id)sender;
@end

@implementation OmegaTrayActions
- (void)showMain:(id)sender {
  (void)sender;
  if (!g_main_window) return;
  [g_main_window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}
- (void)quitApp:(id)sender {
  (void)sender;
  g_quitting = true;
  [NSApp terminate:nil];
}
@end

static OmegaTrayActions* g_tray_actions = nil;

bool fetch_close_to_tray_from_runtime() {
  httplib::Client cli("127.0.0.1", 9877);
  cli.set_connection_timeout(1, 0);
  const auto res = cli.Get("/v1/config");
  if (!res || res->status != 200) return true;
  try {
    const auto root = nlohmann::json::parse(res->body);
    const auto& cfg = root.contains("config") ? root["config"] : root;
    if (cfg.contains("closeToTray") && cfg["closeToTray"].is_boolean()) {
      return cfg["closeToTray"].get<bool>();
    }
  } catch (...) {
  }
  return true;
}

}  // namespace

void shell_tray_init(NativeWindow main_window) {
  NSView* view = (__bridge NSView*)main_window;
  g_main_window = view.window;
  g_close_to_tray = fetch_close_to_tray_from_runtime();
  if (!g_tray_actions) g_tray_actions = [[OmegaTrayActions alloc] init];

  g_status_item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
  NSImage* icon = [NSImage imageNamed:NSImageNameApplicationIcon];
  if (!icon) icon = [NSImage imageNamed:NSImageNameFolder];
  g_status_item.button.image = icon;
  g_status_item.button.toolTip = @"Omega";

  NSMenu* menu = [[NSMenu alloc] init];
  NSMenuItem* show_item = [[NSMenuItem alloc] initWithTitle:@"Show Omega"
                                                   action:@selector(showMain:)
                                            keyEquivalent:@""];
  NSMenuItem* quit_item = [[NSMenuItem alloc] initWithTitle:@"Quit Omega"
                                                   action:@selector(quitApp:)
                                            keyEquivalent:@""];
  [show_item setTarget:g_tray_actions];
  [quit_item setTarget:g_tray_actions];
  [menu addItem:show_item];
  [menu addItem:[NSMenuItem separatorItem]];
  [menu addItem:quit_item];
  g_status_item.menu = menu;
}

void shell_tray_dispose() {
  if (g_status_item) {
    [[NSStatusBar systemStatusBar] removeStatusItem:g_status_item];
    g_status_item = nil;
  }
  g_main_window = nil;
}

bool shell_tray_close_to_tray_enabled() { return g_close_to_tray; }

bool shell_tray_handle_close(NativeWindow main_window) {
  if (g_quitting || !g_close_to_tray) return false;
  NSView* view = (__bridge NSView*)main_window;
  if (view.window) [view.window orderOut:nil];
  return true;
}

bool shell_tray_handle_message(NativeWindow, unsigned, unsigned long long, long long) { return false; }

void shell_tray_show_main_window() {
  if (g_tray_actions) [g_tray_actions showMain:nil];
}

void shell_tray_force_quit() { g_quitting = true; }

void shell_tray_quit_app() {
  if (g_tray_actions) [g_tray_actions quitApp:nil];
}

}  // namespace omega::shell
