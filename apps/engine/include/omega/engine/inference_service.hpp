#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "omega/engine/speculative_config.hpp"

namespace omega::engine {

class InferServerBackend;

enum class InferBackend { None, LibOmega, InferServer };

struct SamplingOptions {
  float temperature = 0.0f;
  float top_p = 0.0f;
  int top_k = 0;
  int max_tokens = 0;
  int seed = 0;
};

struct LoadOptions {
  int context_size = 0;
  /** -1 = unset (use GPU default); 0 = CPU-only. */
  int gpu_layers = -1;
  int batch_size = 0;
  int threads = 0;
  int main_gpu = 0;
  int flash_attn = -1;
  std::string quant_policy;
  std::string mmproj_path;
  SpeculativeOptions speculative;
};

struct TokenChunk {
  std::string text;
  int index = 0;
};

struct GenerationStats {
  int prompt_tokens = 0;
  int completion_tokens = 0;
  int64_t prompt_ms = 0;
  int64_t gen_ms = 0;
  /** Sub-millisecond elapsed time for accurate live tok/s (milliseconds). */
  double prompt_ms_f = 0;
  double gen_ms_f = 0;
};

struct ChatMessage {
  std::string role;
  std::string content;
  std::vector<std::string> images;
  std::vector<std::string> image_paths;
};

using TokenCallback = std::function<bool(const TokenChunk&)>;
using LoadProgressCallback = std::function<void(int percent, const std::string& message)>;

/** Wraps libomega_infer (up to 2 resident GGUF) and optional omega-infer subprocess (MTP). */
class InferenceService {
 public:
  static constexpr size_t kMaxLoaded = 2;

  InferenceService();
  ~InferenceService();
  InferenceService(const InferenceService&) = delete;
  InferenceService& operator=(const InferenceService&) = delete;

  static bool infer_available();
  static bool gpu_offload_available();
  static bool infer_server_available();
  static std::string infer_unavailable_reason();

  bool is_loaded() const;
  bool uses_infer_server() const;
  const std::string& loaded_model_id() const;
  std::vector<std::string> loaded_model_ids() const;
  bool is_model_resident(const std::string& model_id) const;

  /** Loaded context window (n_ctx) for a resident model; 0 if unknown. */
  int loaded_context_size(const std::string& model_id) const;

  bool load(const std::string& model_id, const std::string& path, const LoadOptions& opts,
            std::string& error, LoadProgressCallback on_progress = nullptr);
  bool activate(const std::string& model_id, std::string& error);
  void unload();
  bool unload_model(const std::string& model_id);

  bool generate(const std::string& prompt, const SamplingOptions& sampling,
                TokenCallback on_token, std::string& full_text, std::string& error,
                GenerationStats* stats_out = nullptr);
  bool chat(const std::vector<ChatMessage>& messages, const SamplingOptions& sampling,
            TokenCallback on_token, std::string& full_text, std::string& error,
            bool enable_thinking = false, bool use_simple_prompt = false,
            GenerationStats* stats_out = nullptr);
  bool generate_vision(const std::string& prompt, const std::vector<std::string>& image_paths,
                       const SamplingOptions& sampling, TokenCallback on_token,
                       std::string& full_text, std::string& error);
  bool embed(const std::string& text, std::vector<float>& vector, std::string& error);

  static void build_chat_prompt(const std::vector<ChatMessage>& messages, std::string& prompt,
                                std::vector<std::string>& image_paths, void* model_handle = nullptr,
                                bool enable_thinking = false, bool use_simple_prompt = false);
  static SamplingOptions default_sampling(const SamplingOptions& in);
  static LoadOptions default_load(const LoadOptions& in);

 private:
  struct ResidentModel {
    std::string id;
    std::string path;
    void* handle = nullptr;
    LoadOptions options;
    int64_t last_used_ms = 0;
  };

  mutable std::mutex mutex_;
  InferBackend backend_ = InferBackend::None;
  std::unique_ptr<InferServerBackend> server_;
  std::vector<ResidentModel> residents_;
  std::string active_id_;

  void clear_infer_server_locked();
  void clear_residents_locked();
  void free_resident_locked(ResidentModel& model);
  ResidentModel* find_resident_locked(const std::string& id);
  const ResidentModel* find_resident_locked(const std::string& id) const;
  bool evict_lru_locked(const std::string& except_id);
  void touch_locked(ResidentModel& model);
  void* active_handle_locked();
  bool activate_locked(const std::string& id, std::string& error);
  int64_t now_ms() const;
};

}  // namespace omega::engine
