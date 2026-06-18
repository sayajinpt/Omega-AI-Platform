#include "omega/shell/overlay_window.hpp"

#include "omega/shell/webview_env.hpp"

#include <WebView2.h>
#include <Windows.h>
#include <wrl/client.h>
#include <wrl/event.h>

namespace omega::shell {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;

namespace {

constexpr wchar_t kOverlayClass[] = L"OmegaShellOverlay";

LRESULT CALLBACK OverlayWndProc(HWND hwnd, UINT msg, WPARAM wparam, LPARAM lparam) {
  if (msg == WM_CLOSE) {
    auto* overlay = reinterpret_cast<OverlayWindow*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (overlay) overlay->user_closed();
    return 0;
  }
  if (msg == WM_DESTROY) {
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wparam, lparam);
}

void ensure_overlay_class(HINSTANCE inst) {
  static bool registered = false;
  if (registered) return;
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = OverlayWndProc;
  wc.hInstance = inst;
  wc.lpszClassName = kOverlayClass;
  RegisterClassExW(&wc);
  registered = true;
}

void configure_overlay_webview(ICoreWebView2* webview) {
  if (!webview) return;
  ComPtr<ICoreWebView2Settings> settings;
  if (FAILED(webview->get_Settings(&settings)) || !settings) return;
  settings->put_IsWebMessageEnabled(TRUE);
  settings->put_AreDefaultContextMenusEnabled(FALSE);
  settings->put_IsStatusBarEnabled(FALSE);
}

}  // namespace

struct OverlayWindow::Impl {
  HWND hwnd{nullptr};
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
};

OverlayWindow::OverlayWindow() : impl_(new Impl) {}
OverlayWindow::~OverlayWindow() {
  teardown();
  delete impl_;
  impl_ = nullptr;
}

void OverlayWindow::set_close_handler(std::function<void()> handler) { on_close_ = std::move(handler); }

void OverlayWindow::user_closed() {
  hide();
  if (on_close_) on_close_();
}

void OverlayWindow::show(const std::string& url, int x, int y, int width, int height) {
  visible_ = true;
  HINSTANCE inst = GetModuleHandleW(nullptr);
  ensure_overlay_class(inst);
  const std::wstring wurl(url.begin(), url.end());

  if (!impl_->hwnd) {
    impl_->hwnd = CreateWindowExW(
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW, kOverlayClass, L"Omega Companion",
        WS_POPUP | WS_VISIBLE, x, y, width, height, nullptr, nullptr, inst, nullptr);
    SetWindowLongPtrW(impl_->hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));

    create_webview_environment(
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, wurl](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
              if (FAILED(result) || !env || !impl_->hwnd) return result;
              return env->CreateCoreWebView2Controller(
                  impl_->hwnd,
                  Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                      [this, wurl](HRESULT result2, ICoreWebView2Controller* controller) -> HRESULT {
                        if (FAILED(result2) || !controller || !impl_->hwnd) return result2;
                        impl_->controller = controller;
                        impl_->controller->get_CoreWebView2(&impl_->webview);
                        apply_overlay_webview_background(impl_->controller.Get());
                        configure_overlay_webview(impl_->webview.Get());
                        impl_->controller->put_IsVisible(TRUE);
                        RECT bounds{};
                        GetClientRect(impl_->hwnd, &bounds);
                        impl_->controller->put_Bounds(bounds);
                        impl_->webview->Navigate(wurl.c_str());
                        return S_OK;
                      })
                      .Get());
            })
            .Get());
    return;
  }

  SetWindowPos(impl_->hwnd, HWND_TOPMOST, x, y, width, height, SWP_SHOWWINDOW);
  ShowWindow(impl_->hwnd, SW_SHOW);
  if (impl_->controller) {
    impl_->controller->put_IsVisible(TRUE);
    RECT bounds{};
    GetClientRect(impl_->hwnd, &bounds);
    impl_->controller->put_Bounds(bounds);
  }
  if (impl_->webview) impl_->webview->Navigate(wurl.c_str());
}

void OverlayWindow::hide() {
  visible_ = false;
  if (impl_->controller) impl_->controller->put_IsVisible(FALSE);
  if (impl_->hwnd) ShowWindow(impl_->hwnd, SW_HIDE);
}

void OverlayWindow::teardown() {
  visible_ = false;
  if (impl_->controller) {
    impl_->controller->Close();
    impl_->controller = nullptr;
  }
  impl_->webview = nullptr;
  if (impl_->hwnd) {
    DestroyWindow(impl_->hwnd);
    impl_->hwnd = nullptr;
  }
}

HWND OverlayWindow::hwnd() const {
  return impl_ ? impl_->hwnd : nullptr;
}

void OverlayWindow::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  std::string msg = R"({"type":"omega-shell-event","channel":")";
  msg += channel;
  msg += R"(","payload":)";
  msg += json_payload.empty() ? "null" : json_payload;
  msg += "}";
  const std::wstring wmsg(msg.begin(), msg.end());
  impl_->webview->PostWebMessageAsJson(wmsg.c_str());
}

}  // namespace omega::shell
