#include "omega/shell/shell_menu.hpp"
#include "omega/shell/webview_host.hpp"

#import <Cocoa/Cocoa.h>

namespace omega::shell {

namespace {

WebViewHost* g_webview = nullptr;

@interface OmegaMenuActions : NSObject
- (void)omegaCut:(id)sender;
- (void)omegaCopy:(id)sender;
- (void)omegaPaste:(id)sender;
@end

@implementation OmegaMenuActions
- (void)omegaCut:(id)sender {
  (void)sender;
  if (g_webview) g_webview->exec_editing_command("cut");
}
- (void)omegaCopy:(id)sender {
  (void)sender;
  if (g_webview) g_webview->exec_editing_command("copy");
}
- (void)omegaPaste:(id)sender {
  (void)sender;
  if (g_webview) g_webview->exec_editing_command("paste");
}
@end

}  // namespace

void install_shell_menu(NativeWindow, WebViewHost* webview) {
  g_webview = webview;
  static OmegaMenuActions* actions = [[OmegaMenuActions alloc] init];

  NSMenu* bar = [[NSMenu alloc] init];
  NSMenuItem* appMenuItem = [[NSMenuItem alloc] init];
  NSMenu* appMenu = [[NSMenu alloc] initWithTitle:@"Omega"];
  [appMenu addItemWithTitle:@"Quit Omega" action:@selector(terminate:) keyEquivalent:@"q"];
  [appMenuItem setSubmenu:appMenu];
  [bar addItem:appMenuItem];

  NSMenuItem* editMenuItem = [[NSMenuItem alloc] init];
  NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  NSMenuItem* cut = [editMenu addItemWithTitle:@"Cut" action:@selector(omegaCut:) keyEquivalent:@"x"];
  NSMenuItem* copy = [editMenu addItemWithTitle:@"Copy" action:@selector(omegaCopy:) keyEquivalent:@"c"];
  NSMenuItem* paste = [editMenu addItemWithTitle:@"Paste" action:@selector(omegaPaste:) keyEquivalent:@"v"];
  [cut setTarget:actions];
  [copy setTarget:actions];
  [paste setTarget:actions];
  [editMenuItem setSubmenu:editMenu];
  [bar addItem:editMenuItem];
  [NSApp setMainMenu:bar];
}

void shell_menu_handle_command(int) {}
bool shell_menu_translate_accel(NativeWindow, omega::shell::ShellAccelMsg*) { return false; }

}  // namespace omega::shell
