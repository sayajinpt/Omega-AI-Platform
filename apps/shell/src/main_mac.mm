#include "omega/shell/app_paths.hpp"
#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/overlay_window.hpp"
#include "omega/shell/platform_window.hpp"
#include "omega/shell/runtime_supervisor.hpp"
#include "omega/shell/screen_snip_service.hpp"
#include "omega/shell/shell_context.hpp"
#include "omega/shell/shell_http_server.hpp"
#include "omega/shell/shell_menu.hpp"
#include "omega/shell/static_server.hpp"
#include "omega/shell/webview_host.hpp"

#import <Cocoa/Cocoa.h>

#include <memory>
#include <string>

namespace {

constexpr int kUiPort = 9777;

struct AppState {
  omega::shell::ShellContext shell;
  omega::shell::RuntimeSupervisor runtime;
  omega::shell::StaticServer ui_server;
  omega::shell::WebViewHost webview;
  NSWindow* window{nil};
};

AppState* g_app = nullptr;

std::string ui_url(int port) { return "http://127.0.0.1:" + std::to_string(port) + "/"; }

}  // namespace

@interface OmegaAppDelegate : NSObject <NSApplicationDelegate>
@end

@interface OmegaWindowDelegate : NSObject <NSWindowDelegate>
@end

@implementation OmegaWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
  (void)sender;
  if (!g_app) return YES;
  return omega::shell::shell_tray_handle_close(g_app->shell.main_window) ? NO : YES;
}
@end

@implementation OmegaAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification*)notification {
  (void)notification;
  if (!g_app) return;

  @try {
    g_app->runtime.start();
  } @catch (NSException* e) {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = @"Omega — runtime failed";
    alert.informativeText = e.reason;
    [alert runModal];
    [NSApp terminate:nil];
    return;
  }

  const std::string ui_root = omega::shell::ui_root();
  try {
    g_app->ui_server.start(ui_root, kUiPort);
  } catch (const std::exception& e) {
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = @"Omega — UI server failed";
    alert.informativeText = [NSString stringWithUTF8String:e.what()];
    [alert runModal];
    g_app->runtime.stop();
    [NSApp terminate:nil];
    return;
  }

  g_app->shell.ui_port = kUiPort;
  g_app->shell.runtime_base = "http://127.0.0.1:9877";
  g_app->shell.browser = std::make_unique<omega::shell::EmbeddedBrowser>();
  g_app->shell.avatar_overlay = std::make_unique<omega::shell::OverlayWindow>();
  g_app->shell.screen_snip = std::make_unique<omega::shell::ScreenSnipService>(g_app->shell);
  g_app->shell.shell_http = std::make_unique<omega::shell::ShellHttpServer>();

  NSRect frame = NSMakeRect(100, 100, 1400, 900);
  g_app->window = [[NSWindow alloc] initWithContentRect:frame
                                                styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                           NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
  [g_app->window setTitle:@"Omega"];
  g_app->window.delegate = [[OmegaWindowDelegate alloc] init];
  [g_app->window makeKeyAndOrderFront:nil];

  g_app->shell.main_window = (__bridge void*)g_app->window.contentView;
  g_app->shell.main_webview = &g_app->webview;
  g_app->shell.browser->attach(g_app->shell.main_window);

  g_app->webview.create(g_app->shell.main_window, ui_url(kUiPort));
  omega::shell::install_shell_menu(g_app->shell.main_window, &g_app->webview);
  omega::shell::shell_tray_init(g_app->shell.main_window);
  g_app->shell.shell_http->start(g_app->shell);
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
  (void)sender;
  return !omega::shell::shell_tray_close_to_tray_enabled();
}

- (void)applicationWillTerminate:(NSNotification*)notification {
  (void)notification;
  if (!g_app) return;
  g_app->shell.shell_http->stop();
  g_app->ui_server.stop();
  g_app->runtime.stop();
  omega::shell::shell_tray_dispose();
}

@end

int main(int argc, char* argv[]) {
  (void)argc;
  (void)argv;
  auto app = std::make_unique<AppState>();
  g_app = app.get();

  @autoreleasepool {
    [NSApplication sharedApplication];
    OmegaAppDelegate* delegate = [[OmegaAppDelegate alloc] init];
    [NSApp setDelegate:delegate];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp run];
  }

  g_app = nullptr;
  return 0;
}
