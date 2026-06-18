#include "omega/shell/shell_menu.hpp"

namespace omega::shell {

void install_shell_menu(NativeWindow, WebViewHost*) {}
void shell_menu_handle_command(int) {}
bool shell_menu_translate_accel(NativeWindow, ShellAccelMsg*) { return false; }

void shell_tray_init(NativeWindow) {}
void shell_tray_dispose() {}
bool shell_tray_handle_message(NativeWindow, unsigned, unsigned long long, long long) { return false; }
bool shell_tray_handle_close(NativeWindow) { return false; }
void shell_tray_quit_app() {}
void shell_tray_force_quit() {}

}  // namespace omega::shell
