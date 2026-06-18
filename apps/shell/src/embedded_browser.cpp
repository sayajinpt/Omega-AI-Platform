#include "omega/shell/embedded_browser.hpp"

#include "omega/shell/webview_env.hpp"

#include <WebView2.h>
#include <Windows.h>
#include <wrl/client.h>
#include <wrl/event.h>

#include <string>

namespace omega::shell {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;

struct EmbeddedBrowser::Impl {
  HWND parent{nullptr};
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> webview;
  bool created{false};
  bool events_wired{false};
};

EmbeddedBrowser::EmbeddedBrowser() : impl_(new Impl) {}
EmbeddedBrowser::~EmbeddedBrowser() { delete impl_; impl_ = nullptr; }

void EmbeddedBrowser::attach(NativeWindow parent) {
  impl_->parent = reinterpret_cast<HWND>(parent);
}

namespace {

void raise_browser_host(HWND host) {
  if (!host) return;
  HWND insert_after = HWND_TOP;
  const HWND parent = GetParent(host);
  if (parent) {
    HWND topmost = nullptr;
    for (HWND child = GetWindow(parent, GW_CHILD); child; child = GetWindow(child, GW_HWNDNEXT)) {
      if (child != host) topmost = child;
    }
    if (topmost) insert_after = topmost;
  }
  SetWindowPos(host, insert_after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  BringWindowToTop(host);
}

void sync_host_bounds(HWND host, const BrowserBounds& bounds, ICoreWebView2Controller* controller,
                      bool show_window) {
  if (!host) return;
  if (bounds.width < 8 || bounds.height < 8) return;
  MoveWindow(host, bounds.x, bounds.y, bounds.width, bounds.height, TRUE);
  if (show_window) raise_browser_host(host);
  if (!controller) return;
  RECT rc{};
  GetClientRect(host, &rc);
  if (rc.right - rc.left < 8 || rc.bottom - rc.top < 8) return;
  controller->put_Bounds(rc);
}

std::string wide_to_utf8(LPCWSTR raw) {
  if (!raw) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, raw, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, raw, -1, out.data(), n, nullptr, nullptr);
  if (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

}  // namespace

void EmbeddedBrowser::wire_webview_events() {
  if (!impl_->webview || impl_->events_wired) return;
  impl_->events_wired = true;

  impl_->webview->add_NavigationStarting(
      Callback<ICoreWebView2NavigationStartingEventHandler>(
          [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*) -> HRESULT {
            loading_ = true;
            return S_OK;
          })
          .Get(),
      nullptr);

  impl_->webview->add_NavigationCompleted(
      Callback<ICoreWebView2NavigationCompletedEventHandler>(
          [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
            BOOL success = FALSE;
            if (args) args->get_IsSuccess(&success);
            loading_ = false;
            if (!success) page_title_.clear();
            if (visible_ && impl_->parent) {
              sync_host_bounds(impl_->parent, bounds_, impl_->controller.Get(), true);
            }
            return S_OK;
          })
      .Get(),
      nullptr);

  impl_->webview->add_DocumentTitleChanged(
      Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
          [this](ICoreWebView2* sender, IUnknown*) -> HRESULT {
            LPWSTR title = nullptr;
            if (SUCCEEDED(sender->get_DocumentTitle(&title)) && title) {
              page_title_ = wide_to_utf8(title);
              CoTaskMemFree(title);
            }
            return S_OK;
          })
          .Get(),
      nullptr);
}

void EmbeddedBrowser::apply_pending_navigation() {
  if (pending_url_.empty() || !impl_->webview) return;
  const std::string url = pending_url_;
  pending_url_.clear();
  navigate(url);
}

void EmbeddedBrowser::show(const BrowserBounds& bounds) {
  bounds_ = bounds;
  visible_ = true;
  if (impl_->parent) ShowWindow(impl_->parent, SW_SHOW);
  if (!impl_->created && impl_->parent) {
    create_webview_environment(
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
              if (FAILED(result) || !env) return result;
              return env->CreateCoreWebView2Controller(
                  impl_->parent,
                  Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                      [this](HRESULT result2, ICoreWebView2Controller* controller) -> HRESULT {
                        if (FAILED(result2) || !controller) return result2;
                        impl_->controller = controller;
                        impl_->controller->get_CoreWebView2(&impl_->webview);
                        apply_default_webview_background(impl_->controller.Get());
                        impl_->created = true;
                        wire_webview_events();
                        if (!visible_) {
                          impl_->controller->put_IsVisible(FALSE);
                          if (impl_->parent) ShowWindow(impl_->parent, SW_HIDE);
                          return S_OK;
                        }
                        impl_->controller->put_IsVisible(TRUE);
                        sync_host_bounds(impl_->parent, bounds_, impl_->controller.Get(), true);
                        apply_pending_navigation();
                        return S_OK;
                      })
                      .Get());
            })
            .Get());
    return;
  }
  if (impl_->controller) {
    impl_->controller->put_IsVisible(TRUE);
    sync_host_bounds(impl_->parent, bounds_, impl_->controller.Get(), true);
    apply_pending_navigation();
  }
}

void EmbeddedBrowser::hide() {
  media_command("stop");
  if (impl_->webview) {
    pending_url_.clear();
    loading_ = false;
    impl_->webview->Navigate(L"about:blank");
  }
  visible_ = false;
  loading_ = false;
  pending_url_.clear();
  if (impl_->controller) impl_->controller->put_IsVisible(FALSE);
  if (impl_->parent) {
    MoveWindow(impl_->parent, 0, 0, 0, 0, FALSE);
    ShowWindow(impl_->parent, SW_HIDE);
  }
}

void EmbeddedBrowser::ensure_shown() {
  if (!visible_) return;
  show(bounds_);
}

void EmbeddedBrowser::set_bounds(const BrowserBounds& bounds) {
  bounds_ = bounds;
  if (!visible_) return;
  sync_host_bounds(impl_->parent, bounds_, impl_->controller.Get(), true);
}

bool EmbeddedBrowser::navigate(const std::string& url) {
  if (url.empty()) return false;
  if (!visible_ && bounds_.width >= 8 && bounds_.height >= 8) {
    show(bounds_);
  }
  if (!visible_) {
    pending_url_ = url;
    return false;
  }
  if (!impl_->webview) {
    pending_url_ = url;
    loading_ = true;
    return false;
  }
  pending_url_.clear();
  loading_ = true;
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, nullptr, 0);
  std::wstring wurl(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, wurl.data(), wlen);
  if (!wurl.empty() && wurl.back() == L'\0') wurl.pop_back();
  impl_->webview->Navigate(wurl.c_str());
  return true;
}

bool EmbeddedBrowser::back() {
  if (!impl_->webview) return false;
  impl_->webview->GoBack();
  return true;
}

bool EmbeddedBrowser::forward() {
  if (!impl_->webview) return false;
  impl_->webview->GoForward();
  return true;
}

bool EmbeddedBrowser::reload() {
  if (!impl_->webview) return false;
  impl_->webview->Reload();
  return true;
}

bool EmbeddedBrowser::webview_ready() const { return impl_->created && impl_->webview; }

bool EmbeddedBrowser::can_go_back() const {
  if (!impl_->webview) return false;
  BOOL can = FALSE;
  impl_->webview->get_CanGoBack(&can);
  return can == TRUE;
}

bool EmbeddedBrowser::can_go_forward() const {
  if (!impl_->webview) return false;
  BOOL can = FALSE;
  impl_->webview->get_CanGoForward(&can);
  return can == TRUE;
}

std::string EmbeddedBrowser::document_title() const { return page_title_; }

std::string EmbeddedBrowser::current_url() const {
  if (!impl_->webview) return {};
  LPWSTR raw = nullptr;
  impl_->webview->get_Source(&raw);
  if (!raw) return {};
  std::string out = wide_to_utf8(raw);
  CoTaskMemFree(raw);
  return out;
}

bool EmbeddedBrowser::media_command(const std::string& action) {
  if (!impl_->webview || action.empty()) return false;
  std::wstring script;
  if (action == "pause") {
    script = LR"((function(){var n=0;document.querySelectorAll('video,audio').forEach(function(el){try{el.pause();n++;}catch(e){}});return n>0;})())";
  } else if (action == "resume" || action == "play") {
    script = LR"((function(){var v=document.querySelector('video,audio');if(v){void v.play();return true;}return false;})())";
  } else if (action == "stop") {
    script = LR"((function(){var n=0;document.querySelectorAll('video,audio').forEach(function(el){try{el.pause();el.currentTime=0;n++;}catch(e){}});return n>0;})())";
  } else {
    return false;
  }
  impl_->webview->ExecuteScript(script.c_str(), nullptr);
  return true;
}

}  // namespace omega::shell
