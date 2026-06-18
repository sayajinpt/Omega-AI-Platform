#pragma once

#include "omega/shell/platform_window.hpp"
#include "omega/shell/webview_host.hpp"

#if defined(_WIN32)
struct tagMSG;
using MSG = tagMSG;
#endif

namespace omega::shell {

void install_shell_menu(NativeWindow window, WebViewHost* webview);
void shell_menu_handle_command(int command_id);
#if defined(_WIN32)
bool shell_menu_translate_accel(NativeWindow window, MSG* msg);
#else
struct ShellAccelMsg;
bool shell_menu_translate_accel(NativeWindow window, ShellAccelMsg* msg);
#endif

void shell_tray_init(NativeWindow main_window);
void shell_tray_dispose();
bool shell_tray_close_to_tray_enabled();
bool shell_tray_handle_message(NativeWindow hwnd, unsigned msg, unsigned long long wparam,
                               long long lparam);
bool shell_tray_handle_close(NativeWindow hwnd);
void shell_tray_quit_app();
void shell_tray_force_quit();

}  // namespace omega::shell
