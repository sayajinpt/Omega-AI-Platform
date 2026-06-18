#include "omega/shell/webview_host.hpp"

#include "omega/shell/webview_env.hpp"

#include <WebView2.h>
#include <Windows.h>
#include <wrl/client.h>
#include <wrl/event.h>

#include <string>

namespace omega::shell {

namespace {

std::wstring widen(const std::string& s) {
  if (s.empty()) return L"";
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

void sync_controller_bounds(ICoreWebView2Controller* controller, HWND parent) {
  if (!controller || !parent) return;
  RECT bounds{};
  GetClientRect(parent, &bounds);
  controller->put_Bounds(bounds);
}

}  // namespace

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;

struct WebViewHost::Impl {
  HWND parent{nullptr};
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
};

WebViewHost::WebViewHost() : impl_(new Impl) {}
WebViewHost::~WebViewHost() { delete impl_; impl_ = nullptr; }

bool WebViewHost::create(NativeWindow parent, const std::string& initial_url, ReadyCallback on_ready) {
  impl_->parent = reinterpret_cast<HWND>(parent);
  const std::wstring wurl = widen(initial_url);

  const HRESULT hr = create_webview_environment(
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [this, wurl, on_ready](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
            if (FAILED(result) || !env) {
              if (on_ready) on_ready();
              return result;
            }

            return env->CreateCoreWebView2Controller(
                impl_->parent,
                Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [this, wurl, on_ready](HRESULT result2,
                                           ICoreWebView2Controller* controller) -> HRESULT {
                      if (FAILED(result2) || !controller) {
                        if (on_ready) on_ready();
                        return result2;
                      }

                      impl_->controller = controller;
                      impl_->controller->get_CoreWebView2(&impl_->webview);
                      apply_default_webview_background(impl_->controller.Get());
                      ComPtr<ICoreWebView2Settings> settings;
                      if (SUCCEEDED(impl_->webview->get_Settings(&settings)) && settings) {
                        settings->put_IsWebMessageEnabled(TRUE);
                      }
                      sync_controller_bounds(impl_->controller.Get(), impl_->parent);
                      impl_->webview->Navigate(wurl.c_str());

                      if (on_ready) on_ready();
                      return S_OK;
                    })
                    .Get());
          })
          .Get());

  return SUCCEEDED(hr);
}

void WebViewHost::resize(int width, int height) {
  if (!impl_->controller || !impl_->parent) return;
  if (width > 0 && height > 0) {
    MoveWindow(impl_->parent, 0, 0, width, height, TRUE);
  }
  sync_controller_bounds(impl_->controller.Get(), impl_->parent);
}

void WebViewHost::navigate(const std::string& url) {
  if (!impl_->webview) return;
  const std::wstring wurl = widen(url);
  impl_->webview->Navigate(wurl.c_str());
}

void WebViewHost::focus_host_window() {
  HWND root = impl_->parent ? GetAncestor(impl_->parent, GA_ROOT) : nullptr;
  if (!root) root = impl_->parent;
  if (!root) return;
  if (IsIconic(root)) ShowWindow(root, SW_RESTORE);
  ShowWindow(root, SW_SHOW);
  SetForegroundWindow(root);
}

void WebViewHost::post_shell_event(const std::string& channel, const std::string& json_payload) {
  if (!impl_->webview) return;
  std::string msg = std::string(R"({"type":"omega-shell-event","channel":")") + channel +
                    R"(","payload":)" + (json_payload.empty() ? "null" : json_payload) + "}";
  const std::wstring wmsg = widen(msg);
  impl_->webview->PostWebMessageAsJson(wmsg.c_str());
}

void WebViewHost::exec_editing_command(const char* command) {
  if (!impl_->webview || !command || !*command) return;
  std::string script = std::string("document.execCommand('") + command + "')";
  const std::wstring wscript = widen(script);
  impl_->webview->ExecuteScript(wscript.c_str(), nullptr);
}

}  // namespace omega::shell
