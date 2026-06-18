#pragma once

struct HWND__;
using HWND = HWND__*;

namespace omega::shell {

/** Optional close-to-tray + notification area icon (Windows). */
void shell_tray_init(HWND main_hwnd);
void shell_tray_dispose();
bool shell_tray_close_to_tray_enabled();
bool shell_tray_handle_close(HWND hwnd);
bool shell_tray_handle_message(HWND hwnd, unsigned msg, unsigned long long wparam,
                               long long lparam);
/** Mark the next close as a real quit (File menu / tray Quit). */
void shell_tray_force_quit();
void shell_tray_quit_app();

}  // namespace omega::shell
