#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

/** What the user is trying to do (not which UI page). */
enum class MediaTask {
  Chat,
  Embed,
  ImageGenerate,
  Tts,
  VideoCompose,
};

/** Runtime backend — users never pick this; resolved from model id + task. */
enum class MediaEngine {
  OmegaEngine,
  Ollama,
  Remote,
  /** Transitional: Python Content Studio workers until native pipeline is complete. */
  LegacyContentStudio,
};

struct MediaRoute {
  /** Preferred backend (omega-engine / llama.cpp first). */
  MediaEngine engine{MediaEngine::OmegaEngine};
  /** Used when {@link engine} does not implement the task yet. */
  std::optional<MediaEngine> fallback_engine;
  /** Model id for the primary engine (GGUF path or catalog id). */
  std::string effective_model;
  /** Ollama model tag when {@link fallback_engine} is Ollama. */
  std::string ollama_fallback_model;
  std::string reason;
};

/**
 * Routing policy: chat/embed → native omega-engine. For image/TTS, use the loaded chat model only
 * when it can render that modality; otherwise fall back to Content Studio model roles (image/TTS
 * packs configured under Models).
 */
class MediaEngineRouter {
 public:
  static MediaRoute resolve(const std::string& model_id, MediaTask task,
                            const nlohmann::json& config = nlohmann::json::object());

  /** True when ``model_id`` itself can generate images or speech (not a plain chat GGUF). */
  static bool chat_model_supports_media(const std::string& model_id, MediaTask task);

  /** Backend that should run now (accounts for engine capability gaps). */
  static MediaEngine execution_engine(const MediaRoute& route, MediaTask task);

  /** True when omega-engine already exposes this media task over JSON commands. */
  static bool native_engine_supports(MediaTask task);

  static bool is_ollama_model_id(const std::string& model_id);
  static bool is_remote_model_id(const std::string& model_id);
  static std::string ollama_tag_from_model_id(const std::string& model_id);

  static const char* engine_label(MediaEngine engine);
};

}  // namespace omega::runtime
