#include "omega/shell/shell_menu.hpp"

#include "omega/shell/app_paths.hpp"

#include <Windows.h>
#include <shellapi.h>
#include <winhttp.h>

#include <nlohmann/json.hpp>

#include <string>

namespace omega::shell {

namespace {

constexpr UINT kTrayCallback = WM_APP + 42;
constexpr UINT kTrayShow = 10001;
constexpr UINT kTrayQuit = 10002;

NOTIFYICONDATAW g_tray{};
HWND g_main_hwnd = nullptr;
bool g_quitting = false;
bool g_close_to_tray = true;

std::string http_get_body(const wchar_t* path) {
  HINTERNET session =
      WinHttpOpen(L"omega-desktop/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                  WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return {};

  HINTERNET connect =
      WinHttpConnect(session, L"127.0.0.1", static_cast<INTERNET_PORT>(9877), 0);
  if (!connect) {
    WinHttpCloseHandle(session);
    return {};
  }

  HINTERNET request =
      WinHttpOpenRequest(connect, L"GET", path, nullptr, WINHTTP_NO_REFERER,
                         WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
  if (!request) {
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return {};
  }

  std::string body;
  if (WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0,
                         0) &&
      WinHttpReceiveResponse(request, nullptr)) {
    DWORD available = 0;
    do {
      if (!WinHttpQueryDataAvailable(request, &available) || available == 0) break;
      std::string chunk(available, '\0');
      DWORD read = 0;
      if (!WinHttpReadData(request, chunk.data(), available, &read)) break;
      chunk.resize(read);
      body += chunk;
    } while (available > 0);
  }

  WinHttpCloseHandle(request);
  WinHttpCloseHandle(connect);
  WinHttpCloseHandle(session);
  return body;
}

bool fetch_close_to_tray_from_runtime() {
  const std::string body = http_get_body(L"/v1/config");
  if (body.empty()) return true;
  try {
    const auto root = nlohmann::json::parse(body);
    const auto& cfg = root.contains("config") ? root["config"] : root;
    if (cfg.contains("closeToTray") && cfg["closeToTray"].is_boolean()) {
      return cfg["closeToTray"].get<bool>();
    }
  } catch (...) {
  }
  return true;
}

HICON load_tray_icon() {
  const std::string icon_path = ui_root() + "/icon.png";
  const std::wstring wpath(icon_path.begin(), icon_path.end());
  return static_cast<HICON>(
      LoadImageW(nullptr, wpath.c_str(), IMAGE_ICON, 16, 16, LR_LOADFROMFILE | LR_DEFAULTSIZE));
}

void show_main_window() {
  if (!g_main_hwnd) return;
  if (!IsWindowVisible(g_main_hwnd)) ShowWindow(g_main_hwnd, SW_SHOW);
  if (IsIconic(g_main_hwnd)) ShowWindow(g_main_hwnd, SW_RESTORE);
  SetForegroundWindow(g_main_hwnd);
}

void quit_app() {
  g_quitting = true;
  if (g_main_hwnd) DestroyWindow(g_main_hwnd);
}

void show_tray_menu() {
  HMENU menu = CreatePopupMenu();
  AppendMenuW(menu, MF_STRING, kTrayShow, L"Show Omega");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kTrayQuit, L"Quit Omega");

  POINT pt{};
  GetCursorPos(&pt);
  SetForegroundWindow(g_main_hwnd);
  TrackPopupMenu(menu, TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_main_hwnd, nullptr);
  DestroyMenu(menu);
}

}  // namespace

void shell_tray_init(NativeWindow main_hwnd) {
  g_main_hwnd = reinterpret_cast<HWND>(main_hwnd);
  g_close_to_tray = fetch_close_to_tray_from_runtime();

  HICON icon = load_tray_icon();
  if (!icon) icon = LoadIconW(nullptr, IDI_APPLICATION);

  g_tray = {};
  g_tray.cbSize = sizeof(g_tray);
  g_tray.hWnd = g_main_hwnd;
  g_tray.uID = 1;
  g_tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  g_tray.uCallbackMessage = kTrayCallback;
  g_tray.hIcon = icon;
  wcscpy_s(g_tray.szTip, L"Omega");
  Shell_NotifyIconW(NIM_ADD, &g_tray);
}

void shell_tray_dispose() {
  if (g_tray.hWnd) {
    Shell_NotifyIconW(NIM_DELETE, &g_tray);
    if (g_tray.hIcon) DestroyIcon(g_tray.hIcon);
    g_tray = {};
  }
  g_main_hwnd = nullptr;
}

bool shell_tray_close_to_tray_enabled() {
  return g_close_to_tray;
}

bool shell_tray_handle_close(NativeWindow hwnd) {
  if (g_quitting || !g_close_to_tray) return false;
  ShowWindow(reinterpret_cast<HWND>(hwnd), SW_HIDE);
  return true;
}

bool shell_tray_handle_message(NativeWindow hwnd, unsigned msg, unsigned long long wparam,
                               long long lparam) {
  (void)hwnd;
  if (msg == kTrayCallback) {
    switch (LOWORD(lparam)) {
      case WM_LBUTTONDBLCLK:
        show_main_window();
        return true;
      case WM_RBUTTONUP:
        show_tray_menu();
        return true;
      default:
        break;
    }
  }

  if (msg == WM_COMMAND) {
    switch (LOWORD(wparam)) {
      case kTrayShow:
        show_main_window();
        return true;
      case kTrayQuit:
        quit_app();
        return true;
      default:
        break;
    }
  }

  return false;
}

void shell_tray_show_main_window() {
  show_main_window();
}

void shell_tray_force_quit() {
  g_quitting = true;
}

void shell_tray_quit_app() {
  quit_app();
}

}  // namespace omega::shell
