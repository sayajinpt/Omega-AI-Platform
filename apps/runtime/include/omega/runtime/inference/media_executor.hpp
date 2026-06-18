#pragma once

#include "omega/runtime/inference/media_engine_router.hpp"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

class EngineClient;

struct ImageGenerateResult {
  bool ok{false};
  std::vector<uint8_t> png_bytes;
  /** "engine", "ollama", or empty on failure */
  std::string backend;
  bool ollama_fallback{false};
  bool studio_fallback{false};
  std::string error;
};

struct TtsGenerateResult {
  bool ok{false};
  std::string wav_path;
  std::string backend;
  bool ollama_fallback{false};
  bool studio_fallback{false};
  std::string error;
};

struct TtsSynthesisOptions {
  std::string speaker{"Ryan"};
  std::string language{"English"};
  std::string instruct;
  std::string voice_gender{"any"};
};

struct VideoGenerateResult {
  bool ok{false};
  std::string mp4_path;
  std::string backend;
  bool studio_fallback{false};
  std::string error;
};

/** Engine-first media execution with automatic Ollama fallback. */
class MediaExecutor {
 public:
  static void refresh_capabilities(EngineClient& engine);
  static nlohmann::json capabilities_json();

  static bool native_supports(MediaTask task);

  static ImageGenerateResult generate_image(EngineClient* engine, const nlohmann::json& config,
                                              const std::string& model_id, const std::string& prompt,
                                              int width, int height);

  static TtsGenerateResult generate_tts(EngineClient* engine, const nlohmann::json& config,
                                        const std::string& model_id, const std::string& text,
                                        const std::string& out_path,
                                        const TtsSynthesisOptions& options = {});

  /** Designated text-to-video repo from model roles (empty = use catalog default). */
  static std::string designated_studio_video_repo(const nlohmann::json& config);

  /** True when the pinned/default video diffusers pack exists on disk. */
  static bool video_model_ready(const nlohmann::json& config);

  static VideoGenerateResult generate_video(const nlohmann::json& config, const std::string& prompt,
                                            const std::string& out_path,
                                            const std::string& negative_prompt = "",
                                            bool prefer_full_gpu = false,
                                            int max_duration_seconds = 0);
};

}  // namespace omega::runtime
