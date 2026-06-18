#include "omega/runtime/python/python_supervisor.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/python/setup_progress.hpp"
#include "omega/runtime/python/venv_setup.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

json PythonSupervisor::status() const {
  const fs::path venv = fs::path(omega_home()) / "venvs" / "unified";
  const std::string py = resolve_unified_python();
  json profile_json = json::object();
  const fs::path profile_file = venv / ".omega-profile";
  if (fs::exists(profile_file)) {
    try {
      std::ifstream in(profile_file);
      profile_json = json::parse(in);
    } catch (...) {
    }
  }
  return json{{"venv_path", venv.string()},
              {"python_path", py},
              {"venv_present", fs::exists(py)},
              {"profile", profile_json},
              {"setup_running", setup_running_.load()},
              {"setup_engine", "native-cpp"}};
}

json PythonSupervisor::run_setup(const std::string& profile_in, EventBus& events) {
  if (setup_running_.exchange(true)) {
    throw std::runtime_error("python unified setup already running");
  }
  struct Guard {
    std::atomic<bool>& flag;
    ~Guard() { flag = false; }
  } guard{setup_running_};

  const std::string profile = profile_in.empty() ? "base" : profile_in;
  UnifiedVenvSetupOptions opts;
  opts.profile = profile;
  if (profile == "sidecar" || profile == "full") {
    opts.sidecar_exl2 = true;
    opts.sidecar_onnx = true;
  }
  if (profile == "full") opts.router_models = true;

  ContentStudioSetupProgressTracker tracker(events);
  const auto publish = [&](const std::string& phase, const std::string& detail) {
    tracker.on_phase(phase, detail);
  };

  try {
    std::string last_error;
    const auto publish_with_log = [&](const std::string& phase, const std::string& detail) {
      if (phase == "error") last_error = detail;
      publish(phase, detail);
    };
    const int exit_code = run_unified_venv_setup(opts, publish_with_log);
    if (exit_code != 0) {
      const std::string msg = last_error.empty()
                                  ? ("python unified setup failed (exit " +
                                     std::to_string(exit_code) + ")")
                                  : last_error;
      tracker.publish_error(msg);
      throw std::runtime_error(msg);
    }
    tracker.on_phase("done", resolve_unified_python());
    events.publish("omega:content-studio:changed", json::object());
    return status();
  } catch (const std::exception& e) {
    tracker.publish_error(e.what());
    throw;
  }
}

}  // namespace omega::runtime
