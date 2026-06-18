#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Heuristic finetune profile from model id (GGUF metadata optional later). */
nlohmann::json analyze_model_for_finetune(const std::string& model_id);

}  // namespace omega::runtime
