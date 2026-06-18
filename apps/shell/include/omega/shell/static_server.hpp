#pragma once

#include <string>
#include <thread>

namespace omega::shell {

/** Serve static UI assets on 127.0.0.1 (avoids file:// + absolute asset paths). */
class StaticServer {
 public:
  StaticServer();
  ~StaticServer();

  void start(const std::string& root, int port,
             const std::string& runtime_base = "http://127.0.0.1:9877");
  void stop();
  int port() const { return port_; }

 private:
  void run();

  std::string root_;
  std::string runtime_base_;
  int port_{0};
  void* server_{nullptr};
  std::thread thread_;
  bool running_{false};
};

}  // namespace omega::shell
