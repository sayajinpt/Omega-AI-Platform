#pragma once

#include <Windows.h>

struct HWND__;
using HWND = HWND__*;

namespace omega::shell {

class WebViewHost;

/** Native Win32 menu + accelerators (Electron menu.ts parity for omega:shortcut). */
void install_shell_menu(HWND hwnd, WebViewHost* webview);
bool shell_menu_translate_accel(HWND hwnd, MSG* msg);
void shell_menu_handle_command(int command_id);

}  // namespace omega::shell
