#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime::studio_media {

struct PhaseResult {
  bool ok{false};
  std::string summary;
  std::string error;
  std::vector<nlohmann::json> log_lines;
};

/** Run Content Studio images or TTS phase in unified Python (one model load per phase). */
PhaseResult run_phase(const std::string& phase, const nlohmann::json& request);

bool looks_like_studio_pack(const std::string& model_id);

/** Short Ollama tag (flux, sdxl) — not an HF diffusers repo. */
bool looks_like_ollama_image_model(const std::string& model_id);

/** Use Content Studio diffusers subprocess for scene images. */
bool prefer_studio_images_phase(const std::string& image_model);

/** Unified venv + native_media_phase.py + backend present. */
bool subprocess_ready();

}  // namespace omega::runtime::studio_media
