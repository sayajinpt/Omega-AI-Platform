#pragma once

#include <string>

namespace omega::runtime {

struct ServerOptions {
  std::string host = "127.0.0.1";
  int port = 9877;
  std::string omega_home;
};

}  // namespace omega::runtime
