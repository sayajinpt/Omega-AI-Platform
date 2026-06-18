#include "omega/runtime/http_server.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/runtime_context.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>

namespace omega::runtime {

namespace {

void persist_runtime_port(int port) {
  namespace fs = std::filesystem;
  try {
    const fs::path state = fs::path(omega_home()) / "runtime-state.json";
    fs::create_directories(state.parent_path());
    std::ofstream out(state);
    out << nlohmann::json{{"port", port},
                          {"baseUrl", "http://127.0.0.1:" + std::to_string(port)}}
               .dump(2);
  } catch (...) {
  }
}

}  // namespace

struct HttpServer::Impl {
  ServerOptions options;
  std::unique_ptr<RuntimeContext> ctx;
  httplib::Server svr;
};

HttpServer::HttpServer(ServerOptions options) : impl_(new Impl()) {
  impl_->options = std::move(options);
  impl_->ctx = std::make_unique<RuntimeContext>(impl_->options);
  impl_->ctx->register_routes(impl_->svr);

  // Long handlers (HF snapshot downloads, Python setup, chat+tool approval) must not block peers.
  impl_->svr.new_task_queue = [] { return new httplib::ThreadPool(256); };

  impl_->svr.set_default_headers({{"Access-Control-Allow-Origin", "*"},
                                   {"Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS"},
                                   {"Access-Control-Allow-Headers", "Content-Type, Authorization"}});

  impl_->svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
    res.status = 204;
  });
}

HttpServer::~HttpServer() { delete impl_; }

void HttpServer::run() {
  running_.store(true);
  persist_runtime_port(impl_->options.port);
  impl_->ctx->start_background_services();
  std::cout << "[omega-runtime] listening on http://" << impl_->options.host << ":"
            << impl_->options.port << '\n';
  if (!impl_->svr.listen(impl_->options.host.c_str(), impl_->options.port)) {
    running_.store(false);
    throw std::runtime_error("Failed to bind HTTP server on " + impl_->options.host + ":" +
                             std::to_string(impl_->options.port));
  }
}

void HttpServer::stop() {
  if (!running_.exchange(false)) return;
  impl_->ctx->stop_background_services();
  impl_->svr.stop();
}

}  // namespace omega::runtime
