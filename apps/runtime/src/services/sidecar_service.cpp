#include "omega/runtime/services/sidecar_service.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/process_util.hpp"
#include "omega/runtime/python/venv_setup.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr int k_disk_hint_mb = 2800;

fs::path sidecar_status_file() { return fs::path(omega_home()) / "sidecar-components.json"; }

json read_components() {
  const fs::path p = sidecar_status_file();
  if (!fs::exists(p)) return json{{"exl2", false}, {"onnx", false}};
  try {
    std::ifstream in(p);
    const json j = json::parse(in);
    return json{{"exl2", j.value("exl2", false)}, {"onnx", j.value("onnx", false)}};
  } catch (...) {
    return json{{"exl2", false}, {"onnx", false}};
  }
}

void write_components(bool exl2, bool onnx) {
  std::ofstream out(sidecar_status_file());
  out << json{{"exl2", exl2}, {"onnx", onnx}, {"updatedAt", "native-runtime"}}.dump(2);
}

bool probe_import_sync(const std::string& component) {
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) return false;
  const std::string mod = component == "exl2" ? "exllamav2" : "onnxruntime_genai";
  const std::string cmd = shell_quote(py) + " -c " + shell_quote("import " + mod);
  const CommandResult run = run_process_capture(cmd);
  return run.started && run.exit_code == 0;
}

}  // namespace

bool SidecarService::probe_import(const std::string& component) {
  return probe_import_sync(component);
}

json SidecarService::status() const {
  const json components = read_components();
  const std::string py = resolve_unified_python();
  const fs::path venv = fs::path(omega_home()) / "venvs" / "unified";
  const fs::path sidecar_dir = fs::path(resolve_engines_root()) / "sidecar";
  const bool script_present =
      fs::exists(sidecar_dir / "requirements.txt") &&
      (fs::exists(sidecar_dir / "run-setup.mjs") || fs::exists(sidecar_dir / "setup.mjs"));
  json out{{"scriptPresent", script_present},
           {"venvPresent", fs::exists(py)},
           {"pythonPath", py},
           {"venvPath", venv.string()},
           {"installerScriptsPath", sidecar_dir.string()},
           {"exl2Installed", components.value("exl2", false)},
           {"onnxInstalled", components.value("onnx", false)},
           {"exl2ImportOk", false},
           {"onnxImportOk", false},
           {"installInProgress", install_running_.load()},
           {"diskHintMb", k_disk_hint_mb}};
  if (fs::exists(py)) {
    if (out.value("exl2Installed", false)) out["exl2ImportOk"] = probe_import("exl2");
    if (out.value("onnxInstalled", false)) out["onnxImportOk"] = probe_import("onnx");
  }
  return out;
}

json SidecarService::install(const json& body, EventBus& events) {
  if (install_running_.exchange(true)) {
    throw std::runtime_error("Sidecar install already in progress");
  }
  struct Guard {
    std::atomic<bool>& flag;
    ~Guard() { flag = false; }
  } guard{install_running_};

  json components_in = body.contains("components") ? body["components"] : json::array();
  if (body.is_array() && !body.empty()) components_in = body;
  std::vector<std::string> components;
  const auto collect = [&](const json& arr) {
    if (!arr.is_array()) return;
    for (const auto& c : arr) {
      if (c.is_string()) {
        components.push_back(c.get<std::string>());
      } else if (c.is_array()) {
        for (const auto& inner : c) {
          if (inner.is_string()) components.push_back(inner.get<std::string>());
        }
      }
    }
  };
  collect(components_in);
  if (components.empty() && body.contains("component") && body["component"].is_string()) {
    components.push_back(body["component"].get<std::string>());
  }
  if (components.empty()) throw std::runtime_error("Select at least one engine (exl2 or onnx)");

  const bool want_exl2 =
      std::find(components.begin(), components.end(), "exl2") != components.end();
  const bool want_onnx =
      std::find(components.begin(), components.end(), "onnx") != components.end();
  write_components(want_exl2, want_onnx);

  std::string joined;
  for (size_t i = 0; i < components.size(); ++i) {
    if (i) joined += ',';
    joined += components[i];
  }

  auto publish = [&](const std::string& phase, const std::string& detail) {
    events.publish("omega:engines:sidecar:installProgress", json{{"phase", phase}, {"detail", detail}});
  };

  publish("starting", "Installing " + joined + " into unified venv…");

  UnifiedVenvSetupOptions opts;
  opts.profile = "sidecar";
  opts.sidecar_exl2 = want_exl2;
  opts.sidecar_onnx = want_onnx;

  const int exit_code = run_unified_venv_setup(opts, publish);
  if (exit_code != 0) {
    publish("error", "Sidecar install failed (exit " + std::to_string(exit_code) + ")");
    throw std::runtime_error("Sidecar install failed");
  }

  if (want_exl2 && !probe_import("exl2")) {
    publish("error", "EXL2 packages installed but import failed (NVIDIA GPU + CUDA PyTorch required)");
    throw std::runtime_error("EXL2 import verification failed");
  }
  if (want_onnx && !probe_import("onnx")) {
    publish("error", "ONNX packages installed but import failed — retry install or check VC++ redistributable");
    throw std::runtime_error("ONNX import verification failed");
  }

  publish("done", "Optional engines installed in unified venv");
  return json{{"exl2", want_exl2}, {"onnx", want_onnx}};
}

json SidecarService::uninstall() {
  write_components(false, false);
  return status();
}

}  // namespace omega::runtime
