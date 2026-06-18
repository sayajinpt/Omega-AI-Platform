#include "omega/runtime/finetune/finetune_capabilities.hpp"

#include <algorithm>
#include <regex>
#include <set>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

struct IdGuess {
  json modalities;
  std::string backend;
};

IdGuess guess_from_id(const std::string& model_id) {
  static const struct {
    std::regex pattern;
    json modalities;
    const char* backend;
  } k_patterns[] = {
      {std::regex(R"(llava|bakllava|moondream|internvl|qwen2\.?vl|vision)", std::regex::icase),
       json::array({"image_to_text", "instruction"}), "peft"},
      {std::regex(R"(flux|sdxl|stable-?diff|dreamshaper|playground)", std::regex::icase),
       json::array({"text_to_image"}), "diffusers"},
      {std::regex(R"(embed|bge-|e5-|nomic-embed|gte-)", std::regex::icase),
       json::array({"embedding"}), "prepare-only"},
      {std::regex(R"(whisper|parakeet)", std::regex::icase), json::array({"completion"}),
       "prepare-only"},
  };
  for (const auto& row : k_patterns) {
    if (std::regex_search(model_id, row.pattern)) {
      return {row.modalities, row.backend};
    }
  }
  return {json::array({"instruction", "conversational", "chatml", "alpaca"}), "unsloth"};
}

json default_hyperparams(double param_count, int context_len, const std::string& modality) {
  const bool is_small = param_count < 4e9;
  const bool is_large = param_count > 30e9;
  const int ctx = std::min(context_len > 0 ? context_len : 4096, is_large ? 4096 : 8192);

  json base{{"epochs", is_small ? 3 : 2},
            {"learningRate", is_small ? 2e-4 : 1e-4},
            {"batchSize", is_large ? 1 : (is_small ? 4 : 2)},
            {"gradientAccumulation", is_large ? 8 : 4},
            {"maxSeqLength", modality == "image_to_text" ? std::min(ctx, 4096) : ctx},
            {"loraRank", is_large ? 8 : 16},
            {"loraAlpha", is_large ? 16 : 32},
            {"warmupRatio", 0.05},
            {"saveSteps", 100}};

  if (modality == "text_to_image") {
    base["extras"] = json{{"resolution", 512}, {"trainTextEncoder", false}};
    base["epochs"] = 1;
    base["learningRate"] = 1e-4;
  }
  if (modality == "embedding") {
    base["epochs"] = 1;
    base["learningRate"] = 5e-5;
    base["loraRank"] = 8;
  }
  return base;
}

}  // namespace

json analyze_model_for_finetune(const std::string& model_id) {
  const IdGuess id_guess = guess_from_id(model_id);
  json notes = json::array({"Could not read GGUF metadata — using filename heuristics only."});

  json modalities = id_guess.modalities;
  std::string backend = id_guess.backend;

  const std::string primary = modalities.empty() ? "instruction" : modalities[0].get<std::string>();
  const bool supports_training = backend != "prepare-only" && primary != "embedding";

  if (!supports_training) {
    notes.push_back("This model type is prepare-only in Omega (dataset formatting + config export).");
  } else if (backend == "unsloth") {
    notes.push_back(
        "Recommended backend: Unsloth LoRA (pip install unsloth). Falls back to PEFT if missing.");
  }
  notes.push_back(
      "GGUF files are for inference. Training uses the HuggingFace model ID (set hfModelId in "
      "Advanced) unless you have a local HF folder.");

  json suggested = json::array();
  std::set<std::string> seen;
  for (const auto& m : modalities) {
    const std::string s = m.get<std::string>();
    if (seen.insert(s).second) suggested.push_back(s);
  }

  return json{{"modelId", model_id},
              {"suggestedModalities", suggested},
              {"primaryModality", primary},
              {"hyperparams", default_hyperparams(8e9, 4096, primary)},
              {"notes", notes},
              {"supportsTraining", supports_training},
              {"trainerBackend", backend}};
}

}  // namespace omega::runtime
