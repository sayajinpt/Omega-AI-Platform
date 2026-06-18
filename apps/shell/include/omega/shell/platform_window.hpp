#pragma once

#include <string>

namespace omega::shell {

using NativeWindow = void*;

/** Open a URL in the system default browser (OAuth, updater download, etc.). */
bool open_url_in_browser(const std::string& url);

void show_main_window(NativeWindow window);
void hide_main_window(NativeWindow window);
void focus_main_window(NativeWindow window);

}  // namespace omega::shell
