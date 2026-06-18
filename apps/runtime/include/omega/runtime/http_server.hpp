#pragma once

#include "omega/runtime/server_options.hpp"

#include <atomic>
#include <string>

namespace omega::runtime {

/** Local HTTP API for the native Omega runtime (migration phase 2). */
class HttpServer {
 public:
  explicit HttpServer(ServerOptions options);
  ~HttpServer();

  HttpServer(const HttpServer&) = delete;
  HttpServer& operator=(const HttpServer&) = delete;

  /** Blocks until stop() or process exit. */
  void run();
  void stop();

 private:
  std::atomic<bool> running_{false};
  struct Impl;
  Impl* impl_;
};

}  // namespace omega::runtime
