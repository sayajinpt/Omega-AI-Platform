#include "omega/shell/webview_env.hpp"

#include "omega/shell/app_paths.hpp"

#include <WebView2.h>
#include <Windows.h>
#include <wrl/client.h>

#include <filesystem>

namespace fs = std::filesystem;

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

}  // namespace

std::wstring webview_user_data_folder() {
  const fs::path dir = fs::path(omega_home()) / "WebView2";
  std::error_code ec;
  fs::create_directories(dir, ec);
  return widen(dir.string());
}

HRESULT create_webview_environment(
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* handler) {
  return CreateCoreWebView2EnvironmentWithOptions(nullptr, webview_user_data_folder().c_str(), nullptr,
                                                handler);
}

void apply_default_webview_background(ICoreWebView2Controller* controller) {
  if (!controller) return;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
  if (FAILED(controller->QueryInterface(IID_PPV_ARGS(&controller2))) || !controller2) return;
  COREWEBVIEW2_COLOR color{};
  color.A = 255;
  color.R = 9;
  color.G = 9;
  color.B = 11;
  controller2->put_DefaultBackgroundColor(color);
}

void apply_overlay_webview_background(ICoreWebView2Controller* controller) {
  if (!controller) return;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
  if (FAILED(controller->QueryInterface(IID_PPV_ARGS(&controller2))) || !controller2) return;
  COREWEBVIEW2_COLOR color{};
  color.A = 0;
  color.R = 0;
  color.G = 0;
  color.B = 0;
  controller2->put_DefaultBackgroundColor(color);
}

}  // namespace omega::shell
