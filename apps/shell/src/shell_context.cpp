#include "omega/shell/shell_context.hpp"

#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/overlay_window.hpp"
#include "omega/shell/screen_snip_service.hpp"
#include "omega/shell/shell_http_server.hpp"

#include <cstring>

namespace omega::shell {

namespace {
ShellContext g_ctx;
}  // namespace

ShellContext::ShellContext() = default;
ShellContext::~ShellContext() = default;

ShellContext& shell_context() { return g_ctx; }

std::string ShellContext::ui_page_url(const char* page) const {
  std::string url = "http://127.0.0.1:" + std::to_string(ui_port) + "/";
  if (page && *page) url += page;
  return url;
}

}  // namespace omega::shell
