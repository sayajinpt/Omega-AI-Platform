#pragma once

#include <WebView2.h>

#include <string>

namespace omega::shell {

/** User-data folder under ~/.omega/WebView2 (not beside the exe — avoids pack/install issues). */
std::wstring webview_user_data_folder();

HRESULT create_webview_environment(
    ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* handler);

void apply_default_webview_background(ICoreWebView2Controller* controller);
/** Transparent default — floating companion overlay (HTML uses bg-transparent). */
void apply_overlay_webview_background(ICoreWebView2Controller* controller);

}  // namespace omega::shell
