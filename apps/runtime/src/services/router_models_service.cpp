#include "omega/runtime/services/router_models_service.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/python/venv_setup.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <regex>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

fs::path router_deploy_dir(const std::string& role) {
  return fs::path(omega_home()) / "models" / "router_models" / role;
}

fs::path router_work_dir(const std::string& role) {
  return fs::path(omega_home()) / "cache" / "router-models" / role;
}

bool dir_has_onnx(const fs::path& dir) {
  if (!fs::exists(dir)) return false;
  for (const auto& ent : fs::directory_iterator(dir)) {
    if (ent.path().extension() == ".onnx") return true;
  }
  return false;
}

#ifdef _WIN32
int run_capture_lines(const std::string& cmd, const std::function<void(const std::string&)>& on_line) {
  FILE* pipe = _popen(cmd.c_str(), "r");
  if (!pipe) return -1;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) {
    std::string line = buf;
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (!line.empty()) on_line(line);
  }
  return _pclose(pipe);
}
#endif

bool unified_has_onnxruntime() {
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) return false;
#ifdef _WIN32
  const std::string cmd = "\"" + py + "\" -c \"import onnxruntime\" 2>nul";
  return run_capture_lines(cmd, [](const std::string&) {}) == 0;
#else
  return std::system((py + " -c \"import onnxruntime\" 2>/dev/null").c_str()) == 0;
#endif
}

}  // namespace

json RouterModelsService::status() const {
  const fs::path py = resolve_unified_python();
  const fs::path venv = fs::path(omega_home()) / "venvs" / "unified";
  return json{{"pythonPath", py.string()},
              {"pythonVenvPresent", fs::exists(py)},
              {"venvPath", venv.string()},
              {"buildScriptPresent", fs::exists(resolve_router_models_build_script())},
              {"onnxRuntimePresent", unified_has_onnxruntime()},
              {"embeddingDeployed", dir_has_onnx(router_deploy_dir("embedding"))},
              {"rerankerDeployed", dir_has_onnx(router_deploy_dir("reranker"))},
              {"setupRunning", setup_running_.load()},
              {"buildRunning", build_running_.load()}};
}

json RouterModelsService::install_node_runtime(EventBus& events) {
  return setup_python(events);
}

json RouterModelsService::setup_python(EventBus& events) {
  if (setup_running_.exchange(true)) throw std::runtime_error("router-models setup already running");
  struct Guard {
    std::atomic<bool>& f;
    ~Guard() { f = false; }
  } g{setup_running_};

  UnifiedVenvSetupOptions opts;
  opts.profile = "full";
  opts.router_models = true;

  const int code = run_unified_venv_setup(
      opts, [&](const std::string& phase, const std::string& detail) {
        events.publish("omega:routerModels:buildProgress",
                       json{{"phase", phase}, {"detail", detail}});
      });
  if (code != 0) throw std::runtime_error("router-models python setup failed");
  return status();
}

json RouterModelsService::build(const std::string& role_in, EventBus& events) {
  const std::string role = role_in.empty() ? "embedding" : role_in;
  if (role != "embedding" && role != "reranker") throw std::runtime_error("role must be embedding or reranker");
  if (build_running_.exchange(true)) throw std::runtime_error("router-models build already running");
  struct Guard {
    std::atomic<bool>& f;
    ~Guard() { f = false; }
  } g{build_running_};

  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    throw std::runtime_error("Unified Python venv missing — run POST /v1/python/setup first");
  }
  const std::string script = resolve_router_models_build_script();
  if (!fs::exists(script)) throw std::runtime_error("build script missing: " + script);

  const fs::path work = router_work_dir(role);
  const fs::path deploy = router_deploy_dir(role);
  fs::create_directories(work);
  fs::create_directories(deploy.parent_path());

  const std::string cmd = "\"" + py + "\" \"" + script + "\" --role=" + role + " --work-dir=\"" +
                          work.string() + "\" --deploy-dir=\"" + deploy.string() + "\" 2>&1";

  int code = -1;
#ifdef _WIN32
  code = run_capture_lines(cmd, [&](const std::string& line) {
    static const std::regex re(R"(OMEGA_ROUTER_PROGRESS:(.+))");
    std::smatch m;
    if (std::regex_search(line, m, re)) {
      try {
        const json payload = json::parse(m[1].str());
        events.publish("omega:routerModels:buildProgress", payload);
      } catch (...) {
        events.publish("omega:routerModels:buildProgress",
                       json{{"phase", "build"}, {"detail", line}});
      }
      return;
    }
    events.publish("omega:routerModels:buildProgress", json{{"phase", "build"}, {"detail", line}});
  });
#else
  code = std::system(cmd.c_str());
#endif
  if (code != 0) throw std::runtime_error("router-models build failed for " + role);
  return json{{"role", role}, {"deployDir", deploy.string()}, {"ok", true}};
}

json RouterModelsService::remove(const std::string& role_in) {
  const std::string role = role_in.empty() ? "embedding" : role_in;
  const fs::path deploy = router_deploy_dir(role);
  std::error_code ec;
  if (fs::exists(deploy)) fs::remove_all(deploy, ec);
  const fs::path work = router_work_dir(role);
  if (fs::exists(work)) fs::remove_all(work, ec);
  return json{{"role", role}, {"removed", true}};
}

}  // namespace omega::runtime
