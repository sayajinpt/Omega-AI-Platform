#include "omega/runtime/config_store.hpp"

#include "omega/runtime/paths.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

json ConfigStore::defaults() const {
  const std::string home = omega_home();
  return json{
      {"homeDir", home},
      {"modelsDir", models_dir()},
      {"runtimePort", 9877},
      {"defaultModel", ""},
      {"allowWebFetch", false},
      {"allowBrowser", true},
      {"allowFinetune", true},
      {"allowContentStudio", true},
      {"allowShell", false},
      {"allowHostFilesystem", false},
      {"sandboxRoot", (fs::path(home) / "workspace").string()},
      {"onboardingComplete", false},
      {"llmOrchestrator", true},
      {"llmOrchestratorTwoPhase", false},
      {"maxContextTokens", 8192},
      {"gpuLayers", 35},
      {"autoApproveTools", false},
      {"approvalMode", "smart"},
      {"autoApproveCapabilities", false}};
}

void ConfigStore::ensure_dirs(const json& cfg) const {
  const auto ensure = [](const std::string& p) {
    if (p.empty()) return;
    std::error_code ec;
    fs::create_directories(p, ec);
  };
  ensure(cfg.value("homeDir", omega_home()));
  ensure(cfg.value("modelsDir", models_dir()));
  ensure(cfg.value("sandboxRoot", ""));
  ensure((fs::path(cfg.value("homeDir", omega_home())) / "plugins").string());
}

json ConfigStore::load() {
  const std::string path = config_path();
  json base = defaults();
  if (!fs::exists(path)) {
    ensure_dirs(base);
    std::ofstream out(path);
    out << base.dump(2);
    return base;
  }
  try {
    std::ifstream in(path);
    json raw = json::parse(in);
    if (!raw.is_object()) return base;
    for (auto it = raw.begin(); it != raw.end(); ++it) {
      base[it.key()] = it.value();
    }
    return base;
  } catch (...) {
    return base;
  }
}

json ConfigStore::save_patch(const json& patch) {
  if (!patch.is_object()) {
    throw std::runtime_error("config patch must be a JSON object");
  }
  json cfg = load();
  for (auto it = patch.begin(); it != patch.end(); ++it) {
    cfg[it.key()] = it.value();
  }
  ensure_dirs(cfg);
  std::ofstream out(config_path());
  out << cfg.dump(2);
  return cfg;
}

}  // namespace omega::runtime
