#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ConfigStore;
class EngineClient;

namespace content_studio_native {

/** Engine-first render: scene images (Ollama) → TTS (llama.cpp) → ffmpeg MP4. */
nlohmann::json run_production_bundle(ConfigStore& config, EngineClient& engine,
                                     const nlohmann::json& body);

bool should_use_native_media(const nlohmann::json& payload, const std::string& hf_tts_repo,
                             const std::string& hf_image_repo, bool no_image_mode);

}  // namespace content_studio_native
}  // namespace omega::runtime
