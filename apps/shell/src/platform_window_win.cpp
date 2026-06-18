#include "omega/shell/platform_window.hpp"

#include <Windows.h>
#include <shellapi.h>

namespace omega::shell {

bool open_url_in_browser(const std::string& url) {
  if (url.empty()) return false;
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, nullptr, 0);
  std::wstring wurl(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, wurl.data(), wlen);
  if (!wurl.empty() && wurl.back() == L'\0') wurl.pop_back();
  HINSTANCE rc = ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  return reinterpret_cast<intptr_t>(rc) > 32;
}

void show_main_window(NativeWindow window) {
  HWND hwnd = reinterpret_cast<HWND>(window);
  if (!hwnd) return;
  if (!IsWindowVisible(hwnd)) ShowWindow(hwnd, SW_SHOW);
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  SetForegroundWindow(hwnd);
}

void hide_main_window(NativeWindow window) {
  HWND hwnd = reinterpret_cast<HWND>(window);
  if (hwnd) ShowWindow(hwnd, SW_HIDE);
}

void focus_main_window(NativeWindow window) { show_main_window(window); }

}  // namespace omega::shell
