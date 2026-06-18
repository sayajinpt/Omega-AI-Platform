#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Scan ~/.omega/models for ONNX GenAI and EXL2 chat packs (sidecar backends). */
nlohmann::json scan_sidecar_models(const std::string& models_dir);

/** Resolve on-disk directory for a sidecar model id (pack folder). Empty if unknown. */
std::string sidecar_model_directory(const std::string& models_dir, const std::string& model_id);

/** Detect sidecar backend from a model directory path. Returns "onnx", "exl2", or empty. */
std::string detect_sidecar_format(const std::string& model_dir);

bool is_sidecar_inference_backend(const std::string& backend);

}  // namespace omega::runtime
