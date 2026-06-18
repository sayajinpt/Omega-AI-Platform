#pragma once

#include "omega/shell/shell_context.hpp"

namespace omega::shell {

constexpr int kShellHttpPort = 9878;

class ShellHttpServer {
 public:
  ShellHttpServer();
  ~ShellHttpServer();

  void start(ShellContext& ctx);
  void stop();

 private:
  struct Impl;
  Impl* impl_{nullptr};
};

}  // namespace omega::shell
