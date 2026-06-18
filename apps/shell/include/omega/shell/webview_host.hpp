#pragma once

#include "omega/shell/platform_window.hpp"

#include <functional>
#include <string>

namespace omega::shell {

class WebViewHost {
 public:
  using ReadyCallback = std::function<void()>;

  WebViewHost();
  ~WebViewHost();

  WebViewHost(const WebViewHost&) = delete;
  WebViewHost& operator=(const WebViewHost&) = delete;

  bool create(NativeWindow parent, const std::string& initial_url, ReadyCallback on_ready = {});
  void resize(int width, int height);
  void navigate(const std::string& url);
  void post_shell_event(const std::string& channel, const std::string& json_payload);
  void exec_editing_command(const char* command);
  void focus_host_window();

 private:
  struct Impl;
  Impl* impl_{nullptr};
};

}  // namespace omega::shell
