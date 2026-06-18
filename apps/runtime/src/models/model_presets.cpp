#include "omega/runtime/models/model_presets.hpp"

#include <stdexcept>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

const json k_presets = json::array({
    json{{"id", "balanced"},
         {"label", "Balanced"},
         {"description", "Stable default for most machines."},
         {"patch",
          json{{"gpuBackend", "auto"},
               {"gpuLayers", 35},
               {"contextSize", 8192},
               {"batchSize", 512},
               {"threads", 0},
               {"kvCacheOnGpu", true},
               {"kCacheType", "f16"},
               {"vCacheType", "f16"}}}},
    json{{"id", "low_vram"},
         {"label", "Low VRAM"},
         {"description", "Lower GPU usage for smaller cards."},
         {"patch",
          json{{"gpuBackend", "auto"},
               {"gpuLayers", 12},
               {"contextSize", 4096},
               {"batchSize", 256},
               {"kvCacheOnGpu", false},
               {"kCacheType", "q8_0"},
               {"vCacheType", "q8_0"}}}},
    json{{"id", "max_speed"},
         {"label", "Max Speed"},
         {"description", "Prioritize throughput and responsiveness."},
         {"patch",
          json{{"gpuBackend", "auto"},
               {"gpuLayers", 999},
               {"contextSize", 4096},
               {"batchSize", 1024},
               {"kvCacheOnGpu", true},
               {"kCacheType", "f16"},
               {"vCacheType", "f16"}}}},
    json{{"id", "cpu_only"},
         {"label", "CPU Only"},
         {"description", "Run without GPU offload."},
         {"patch",
          json{{"gpuBackend", "cpu"},
               {"gpuLayers", 0},
               {"contextSize", 4096},
               {"batchSize", 256},
               {"kvCacheOnGpu", false},
               {"kCacheType", "q8_0"},
               {"vCacheType", "q8_0"}}}},
    json{{"id", "max_context"},
         {"label", "Max Context"},
         {"description", "Prefer longer context windows."},
         {"patch",
          json{{"gpuBackend", "auto"},
               {"gpuLayers", 24},
               {"contextSize", 32768},
               {"batchSize", 256},
               {"kvCacheOnGpu", false},
               {"kCacheType", "q8_0"},
               {"vCacheType", "q8_0"}}}}});

}  // namespace

json list_model_presets() { return k_presets; }

json apply_model_preset(ModelConfigStore& store, const std::string& model_id,
                        const std::string& preset_id) {
  json preset;
  for (const auto& p : k_presets) {
    if (p.value("id", "") == preset_id) {
      preset = p;
      break;
    }
  }
  if (preset.empty()) throw std::runtime_error("Unknown model preset: " + preset_id);
  const json prev = store.get(model_id);
  json patch = preset["patch"];
  if (prev.contains("speculative")) patch["speculative"] = prev["speculative"];
  if (prev.contains("adapters")) patch["adapters"] = prev["adapters"];
  return store.set(model_id, patch);
}

}  // namespace omega::runtime
