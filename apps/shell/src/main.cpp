#include "omega/shell/platform_window.hpp"
#include "omega/shell/app_paths.hpp"
#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/overlay_window.hpp"
#include "omega/shell/runtime_supervisor.hpp"
#include "omega/shell/screen_snip_service.hpp"
#include "omega/shell/shell_context.hpp"
#include "omega/shell/shell_http_server.hpp"
#include "omega/shell/shell_menu.hpp"
#include "omega/shell/shell_ui_dispatch.hpp"
#include "omega/shell/static_server.hpp"
#include "omega/shell/webview_host.hpp"

#include <Windows.h>
#include <shellscalingapi.h>

#include <memory>
#include <string>

namespace {

constexpr int kUiPort = 9777;
constexpr wchar_t kWindowClass[] = L"OmegaDesktopShell";
#ifndef IDI_ICON1
#define IDI_ICON1 101
#endif

struct AppState {
  omega::shell::ShellContext shell;
  omega::shell::RuntimeSupervisor runtime;
  omega::shell::StaticServer ui_server;
  omega::shell::WebViewHost webview;
  HWND content_host{nullptr};
  HWND browser_host{nullptr};
};

AppState* state_from_hwnd(HWND hwnd) {
  return reinterpret_cast<AppState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  if (msg == WM_NCCREATE) {
    auto* cs = reinterpret_cast<CREATESTRUCTW*>(lparam);
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(cs->lpCreateParams));
  }

  AppState* app = state_from_hwnd(hwnd);
  if (omega::shell::shell_tray_handle_message(reinterpret_cast<omega::shell::NativeWindow>(hwnd), msg,
                                              wparam, lparam)) {
    return 0;
  }
  if (omega::shell::shell_ui_dispatch_message(msg, wparam, lparam)) {
    return 0;
  }
  switch (msg) {
    case WM_COMMAND:
      if (LOWORD(wparam) != 0) {
        omega::shell::shell_menu_handle_command(LOWORD(wparam));
      }
      return 0;
    case WM_SIZE:
      if (app && wparam != SIZE_MINIMIZED) {
        const int w = LOWORD(lparam);
        const int h = HIWORD(lparam);
        if (app->content_host) {
          MoveWindow(app->content_host, 0, 0, w, h, TRUE);
        }
        app->webview.resize(w, h);
      }
      return 0;
    case WM_CLOSE:
      if (app &&
          omega::shell::shell_tray_handle_close(reinterpret_cast<omega::shell::NativeWindow>(hwnd)))
        return 0;
      break;
    case WM_DESTROY:
      omega::shell::shell_tray_dispose();
      PostQuitMessage(0);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

void register_window_class(HINSTANCE instance) {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.lpszClassName = kWindowClass;
  wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_ICON1));
  if (!wc.hIcon) wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wc.hIconSm = wc.hIcon;
  RegisterClassExW(&wc);
}

std::string ui_url(int port) { return "http://127.0.0.1:" + std::to_string(port) + "/"; }

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  auto app = std::make_unique<AppState>();

  try {
    app->runtime.start();
  } catch (const std::exception& e) {
    MessageBoxA(nullptr, e.what(), "Omega — runtime failed", MB_ICONERROR);
    CoUninitialize();
    return 1;
  }

  const std::string ui_root = omega::shell::ui_root();
  try {
    app->ui_server.start(ui_root, kUiPort);
  } catch (const std::exception& e) {
    MessageBoxA(nullptr, e.what(), "Omega — UI server failed", MB_ICONERROR);
    app->runtime.stop();
    CoUninitialize();
    return 1;
  }

  app->shell.ui_port = kUiPort;
  app->shell.runtime_base = "http://127.0.0.1:9877";
  app->shell.browser = std::make_unique<omega::shell::EmbeddedBrowser>();
  app->shell.avatar_overlay = std::make_unique<omega::shell::OverlayWindow>();
  app->shell.screen_snip = std::make_unique<omega::shell::ScreenSnipService>(app->shell);
  app->shell.shell_http = std::make_unique<omega::shell::ShellHttpServer>();

  register_window_class(instance);

  app->shell.main_window = reinterpret_cast<omega::shell::NativeWindow>(CreateWindowExW(
      0, kWindowClass, L"Omega",
      WS_OVERLAPPEDWINDOW | WS_VISIBLE, CW_USEDEFAULT, CW_USEDEFAULT, 1400, 900, nullptr, nullptr,
      instance, app.get()));

  if (!app->shell.main_window) {
    MessageBoxW(nullptr, L"CreateWindowEx failed", L"Omega", MB_ICONERROR);
    app->runtime.stop();
    CoUninitialize();
    return 1;
  }

  const HWND main_hwnd = reinterpret_cast<HWND>(app->shell.main_window);
  RECT client{};
  GetClientRect(main_hwnd, &client);
  app->content_host = CreateWindowExW(
      0, L"STATIC", nullptr, WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN, 0, 0, client.right, client.bottom,
      main_hwnd, nullptr, instance, nullptr);
  app->browser_host = CreateWindowExW(0, L"STATIC", nullptr, WS_CHILD, 0, 0, 0, 0, app->content_host,
                                      nullptr, instance, nullptr);
  ShowWindow(app->browser_host, SW_HIDE);

  app->shell.main_webview = &app->webview;
  app->shell.browser->attach(reinterpret_cast<omega::shell::NativeWindow>(app->browser_host));

  ShowWindow(main_hwnd, show);
  UpdateWindow(main_hwnd);

  app->webview.create(reinterpret_cast<omega::shell::NativeWindow>(app->content_host), ui_url(kUiPort));
  omega::shell::install_shell_menu(app->shell.main_window, &app->webview);
  GetClientRect(main_hwnd, &client);
  SendMessageW(main_hwnd, WM_SIZE, SIZE_RESTORED, MAKELPARAM(client.right, client.bottom));
  omega::shell::shell_tray_init(app->shell.main_window);
  app->shell.shell_http->start(app->shell);

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    if (omega::shell::shell_menu_translate_accel(app->shell.main_window, &msg)) continue;
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  app->shell.shell_http->stop();
  app->ui_server.stop();
  app->runtime.stop();
  CoUninitialize();
  return static_cast<int>(msg.wParam);
}
