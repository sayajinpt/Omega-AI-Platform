#pragma once

#include "omega/runtime/config_store.hpp"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

class EngineClient;

/** Per-model settings merged from model-config.json and config modelConfigs. */
nlohmann::json resolve_model_settings(ConfigStore& config, const std::string& model_id);

/** Engine model.load body with context_size, gpu_layers, etc. */
nlohmann::json build_model_load_payload(ConfigStore& config, const std::string& model_id,
                                        nlohmann::json body = nlohmann::json::object());

/** Sub-object for chat.send loadOptions (engine parse_load_options). */
nlohmann::json build_engine_load_options(ConfigStore& config, const std::string& model_id);

/** Loaded n_ctx from engine model.loaded (actual llama context, 0 if unknown). */
int query_loaded_context_size(EngineClient& engine, const std::string& model_id);

/** Configured contextSize for model_id (model card / global default). */
int resolve_context_size(ConfigStore& config, const std::string& model_id);

/** min(configured, loaded actual n_ctx) when engine reports a loaded context. */
int resolve_effective_context_size(ConfigStore& config, EngineClient& engine,
                                     const std::string& model_id);

/** Merge loadOptions (+ optional simple promptFormat) for chat.send. */
void apply_chat_send_load_options(ConfigStore& config, const std::string& model_id,
                                  nlohmann::json& payload, bool simple_prompt = false);

/** JSON/script generation: model chat template, thinking off, preserve configured context. */
void apply_structured_generation_options(ConfigStore& config, const std::string& model_id,
                                         nlohmann::json& payload);

/** GPU layer counts to try: full offload → partial GPU+CPU hybrid → CPU-only. */
std::vector<int> model_load_gpu_tiers(ConfigStore& config, const std::string& model_id,
                                      const nlohmann::json& body = nlohmann::json::object());

void apply_gpu_layers_to_load_body(nlohmann::json& body, int gpu_layers);

bool model_load_engine_died(const std::string& message, bool engine_available);

bool model_load_error_is_fatal(const std::string& message);
/** True when retrying model.load with fewer GPU layers may succeed (VRAM pressure). */
bool model_load_error_may_retry_lower_gpu(const std::string& message);

}  // namespace omega::runtime
