#pragma once

#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "omega/engine/inference_service.hpp"
#include "omega/engine/speculative_config.hpp"

namespace omega::engine {

/** Spawns bundled omega-infer (llama-server) for MTP / speculative decoding. */
class InferServerBackend {
 public:
  static bool infer_binary_available();
  static std::string resolve_infer_binary();

  InferServerBackend();
  ~InferServerBackend();

  InferServerBackend(const InferServerBackend&) = delete;
  InferServerBackend& operator=(const InferServerBackend&) = delete;

  bool is_running() const { return running_; }

  bool start(const std::string& model_path, const LoadOptions& load, const SpeculativeOptions& spec,
             std::string& error);
  void stop();

  bool generate(const std::string& prompt, const SamplingOptions& sampling, TokenCallback on_token,
                std::string& full_text, std::string& error,
                GenerationStats* stats_out = nullptr);

  bool chat(const std::vector<ChatMessage>& messages, const SamplingOptions& sampling,
            TokenCallback on_token, std::string& full_text, std::string& error,
            GenerationStats* stats_out = nullptr);

  bool embed(const std::string& text, std::vector<float>& vector, std::string& error);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  bool running_ = false;

  bool stream_completion(const std::string& path, const nlohmann::json& body, TokenCallback on_token,
                         std::string& full_text, std::string& error,
                         GenerationStats* stats_out = nullptr);
};

}  // namespace omega::engine
