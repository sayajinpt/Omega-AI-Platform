#pragma once

#include "omega/shell/platform_window.hpp"

#include <functional>

namespace omega::shell {

/** Custom window message — run posted work on the main shell UI thread. */
constexpr unsigned kShellUiMessage = 0x8001;  // WM_APP + 1

/** Handle in the main window procedure before DefWindowProc. Returns true if handled. */
bool shell_ui_dispatch_message(unsigned msg, std::uintptr_t wparam, std::intptr_t lparam);

/** Run work on the thread that owns {@p main_window}. Blocks until complete. */
void shell_ui_run_sync(NativeWindow main_window, std::function<void()> work);

/** Run work on the UI thread without blocking the caller. */
void shell_ui_run_async(NativeWindow main_window, std::function<void()> work);

}  // namespace omega::shell
