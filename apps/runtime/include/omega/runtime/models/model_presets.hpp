#pragma once

#include "omega/runtime/storage/model_config_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

nlohmann::json list_model_presets();
nlohmann::json apply_model_preset(ModelConfigStore& store, const std::string& model_id,
                                  const std::string& preset_id);

}  // namespace omega::runtime
