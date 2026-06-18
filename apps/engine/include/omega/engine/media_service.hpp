#pragma once

#include "omega/engine/model_registry.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::engine::media {

nlohmann::json capabilities_json();

/** Synchronous TTS to WAV via bundled llama-cli / llama-tts when present. */
nlohmann::json tts_generate(ModelRegistry& registry, const nlohmann::json& payload, std::string& error);

nlohmann::json image_generate(ModelRegistry& registry, const nlohmann::json& payload,
                              std::string& error);

}  // namespace omega::engine::media
