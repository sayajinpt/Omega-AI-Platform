#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <string>

#include "omega/engine/engine.hpp"
#include "omega/engine/json_protocol.hpp"
#ifdef _WIN32
#include "omega/engine/win_shared_dll_paths.hpp"
#endif

namespace fs = std::filesystem;

namespace {

std::mutex g_stdout_mutex;

void write_stdout(const std::string& line) {
  std::lock_guard lock(g_stdout_mutex);
  std::cout << line << '\n';
  std::cout.flush();
}

bool arg_value(int argc, char** argv, const char* flag, std::string& out) {
  for (int i = 1; i < argc - 1; ++i) {
    if (std::string(argv[i]) == flag) {
      out = argv[i + 1];
      return true;
    }
  }
  return false;
}

std::string default_omega_home() {
#ifdef _WIN32
  const char* home = std::getenv("USERPROFILE");
#else
  const char* home = std::getenv("HOME");
#endif
  if (!home) return {};
  return (fs::path(home) / ".omega").string();
}

std::string resolve_models_dir(int argc, char** argv) {
  std::string models_dir;
  if (arg_value(argc, argv, "--models-dir", models_dir) && !models_dir.empty()) {
    return models_dir;
  }
  const char* home = std::getenv("OMEGA_HOME");
  if (home && *home) {
    return (fs::path(home) / "models").string();
  }
  const auto fallback = default_omega_home();
  if (!fallback.empty()) return (fs::path(fallback) / "models").string();
  return "models";
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
  omega::init_shared_dll_search_paths();
  setvbuf(stderr, nullptr, _IONBF, 0);
#endif
  const std::string models_dir = resolve_models_dir(argc, argv);
  std::error_code ec;
  fs::create_directories(models_dir, ec);

#ifdef _WIN32
  std::fprintf(stderr, "omega-engine started models_dir=%s\n", models_dir.c_str());
  std::fflush(stderr);
#endif

  omega::engine::Engine engine(models_dir);
  engine.set_event_sink([](const std::string& line) {
    if (!line.empty()) write_stdout(line);
  });

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    const auto cmd = omega::engine::JsonProtocol::parse_request(line);
    if (!cmd) continue;

    const auto resp = engine.dispatch(*cmd);
    if (omega::engine::Engine::is_async_command(cmd->type)) {
      // Async handlers enqueue work; only emit an immediate response for pre-queue failures
      // (e.g. model not found) so the Electron client is not left waiting forever.
      if (!resp.success) {
        write_stdout(omega::engine::JsonProtocol::serialize_response(resp));
      }
      continue;
    }

    write_stdout(omega::engine::JsonProtocol::serialize_response(resp));
  }
  return 0;
}
