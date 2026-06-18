#include "omega/runtime/http_server.hpp"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

int parse_port(int argc, char** argv) {
  const char* env = std::getenv("OMEGA_RUNTIME_PORT");
  if (env && *env) {
    try {
      return std::stoi(env);
    } catch (...) {
      /* fall through */
    }
  }
  for (int i = 1; i < argc - 1; ++i) {
    if (std::string(argv[i]) == "--port") {
      return std::stoi(argv[i + 1]);
    }
  }
  return 9877;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    omega::runtime::ServerOptions opts;
    opts.port = parse_port(argc, argv);
    omega::runtime::HttpServer server(std::move(opts));
    server.run();
  } catch (const std::exception& e) {
    std::cerr << "[omega-runtime] fatal: " << e.what() << '\n';
    return 1;
  }
  return 0;
}
