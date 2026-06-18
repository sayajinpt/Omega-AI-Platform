#include "omega/runtime/storage/model_config_store.hpp"

#include "omega/runtime/paths.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

std::string ModelConfigStore::file_path() const {
  return (fs::path(omega_home()) / "model-config.json").string();
}

json ModelConfigStore::defaults() {
  return json{{"contextSize", 8192},
              {"gpuLayers", 999},
              {"batchSize", 512},
              {"threads", 0},
              {"useMmap", true},
              {"useMlock", false},
              {"kvCacheOnGpu", true},
              {"kCacheType", "f16"},
              {"vCacheType", "f16"},
              {"seed", -1},
              {"attentionMode", "auto"},
              {"mainGpu", 0},
              {"tensorSplit", json::array()},
              {"gpuBackend", "auto"}};
}

std::string ModelConfigStore::normalize_key(const std::string& model_id) {
  std::string out = model_id;
  while (!out.empty() && (out.front() == ' ' || out.front() == '\t')) out.erase(out.begin());
  while (!out.empty() && (out.back() == ' ' || out.back() == '\t')) out.pop_back();
  return out;
}

json ModelConfigStore::load_all() const {
  const fs::path path = file_path();
  if (!fs::exists(path)) return json::object();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_object() ? root : json::object();
  } catch (...) {
    return json::object();
  }
}

void ModelConfigStore::persist(const json& all) const {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << all.dump(2);
}

json ModelConfigStore::list() const { return load_all(); }

json ModelConfigStore::get(const std::string& model_id) const {
  const std::string key = normalize_key(model_id);
  const json all = load_all();
  if (all.contains(key)) return all[key];
  return defaults();
}

json ModelConfigStore::set(const std::string& model_id, const json& patch) {
  const std::string key = normalize_key(model_id);
  if (key.empty()) throw std::runtime_error("modelId required");
  json all = load_all();
  json next = defaults();
  if (all.contains(key)) {
    for (auto it = all[key].begin(); it != all[key].end(); ++it) next[it.key()] = it.value();
  }
  if (patch.is_object()) {
    for (auto it = patch.begin(); it != patch.end(); ++it) next[it.key()] = it.value();
  }
  all[key] = next;
  persist(all);
  return next;
}

json ModelConfigStore::reset(const std::string& model_id) {
  const std::string key = normalize_key(model_id);
  json all = load_all();
  all.erase(key);
  persist(all);
  return defaults();
}

}  // namespace omega::runtime
