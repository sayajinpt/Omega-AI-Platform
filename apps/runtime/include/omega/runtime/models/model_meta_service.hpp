#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/storage/model_config_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ModelMetaService {
 public:
  ModelMetaService(ConfigStore& config, ModelConfigStore& model_config, EngineClient& engine);

  nlohmann::json inspect(const std::string& model_id) const;
  nlohmann::json estimate_file(int64_t size_bytes, int context = 4096,
                               const std::string& quant = "") const;
  nlohmann::json estimate(const std::string& model_id, const nlohmann::json& config,
                          int gpu_total_mb = 0, int gpu_budget_mb = 0) const;
  nlohmann::json footprint(const std::string& model_id) const;
  nlohmann::json benchmark(const std::string& model_id);

  std::string resolve_path(const std::string& model_id) const;

 private:
  ConfigStore& config_;
  ModelConfigStore& model_config_;
  EngineClient& engine_;

  static std::string quant_from_name(const std::string& model_id);
};

}  // namespace omega::runtime
