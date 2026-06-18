#include "omega/runtime/inference/media_engine_router.hpp"

#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/media/studio_media_runner.hpp"

#include <cctype>

namespace omega::runtime {

namespace {

std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool starts_with_ci(const std::string& s, const std::string& prefix) {
  if (s.size() < prefix.size()) return false;
  for (size_t i = 0; i < prefix.size(); ++i) {
    if (std::tolower(static_cast<unsigned char>(s[i])) !=
        std::tolower(static_cast<unsigned char>(prefix[i]))) {
      return false;
    }
  }
  return true;
}

std::string config_ollama_image_model(const nlohmann::json& config) {
  const auto img = config.value("imageGeneration", nlohmann::json::object());
  if (img.contains("ollamaModel") && img["ollamaModel"].is_string()) {
    const std::string m = img["ollamaModel"].get<std::string>();
    if (!m.empty()) return m;
  }
  return "flux";
}

bool config_use_ollama_for_images(const nlohmann::json& config) {
  const auto img = config.value("imageGeneration", nlohmann::json::object());
  return img.value("useOllama", false);
}

std::string config_ollama_tts_model(const nlohmann::json& config) {
  const auto tts = config.value("ttsGeneration", nlohmann::json::object());
  if (tts.contains("ollamaModel") && tts["ollamaModel"].is_string()) {
    const std::string m = tts["ollamaModel"].get<std::string>();
    if (!m.empty()) return m;
  }
  return "";
}

std::string config_native_image_model(const std::string& model_id, const nlohmann::json& config) {
  if (!model_id.empty() && !MediaEngineRouter::is_ollama_model_id(model_id) &&
      !MediaEngineRouter::is_remote_model_id(model_id)) {
    return model_id;
  }
  const auto img = config.value("imageGeneration", nlohmann::json::object());
  if (img.contains("modelId") && img["modelId"].is_string()) {
    const std::string m = img["modelId"].get<std::string>();
    if (!m.empty()) return m;
  }
  if (config.contains("defaultModel") && config["defaultModel"].is_string()) {
    const std::string m = config["defaultModel"].get<std::string>();
    if (!m.empty()) return m;
  }
  return {};
}

std::string config_native_tts_model(const std::string& model_id, const nlohmann::json& config) {
  if (!model_id.empty() && !MediaEngineRouter::is_ollama_model_id(model_id) &&
      !MediaEngineRouter::is_remote_model_id(model_id)) {
    return model_id;
  }
  const auto tts = config.value("ttsGeneration", nlohmann::json::object());
  if (tts.contains("modelId") && tts["modelId"].is_string()) {
    const std::string m = tts["modelId"].get<std::string>();
    if (!m.empty()) return m;
  }
  if (config.contains("defaultModel") && config["defaultModel"].is_string()) {
    const std::string m = config["defaultModel"].get<std::string>();
    if (!m.empty()) return m;
  }
  return {};
}

bool looks_like_diffusers_studio_pack(const std::string& model_id) {
  const std::string id = lower(model_id);
  if (id.find("generation-models") != std::string::npos) return true;
  if (id.find("interdiffusion") != std::string::npos) return true;
  if (id.find("diffusers") != std::string::npos) return true;
  if (id.find("qwen") != std::string::npos && id.find("tts") != std::string::npos) return true;
  return false;
}

bool looks_like_gguf_model(const std::string& model_id) {
  const std::string id = lower(model_id);
  return id.find(".gguf") != std::string::npos || id.find("gguf") != std::string::npos;
}

}  // namespace

bool MediaEngineRouter::is_ollama_model_id(const std::string& model_id) {
  return starts_with_ci(model_id, "ollama:");
}

bool MediaEngineRouter::is_remote_model_id(const std::string& model_id) {
  return starts_with_ci(model_id, "remote:");
}

std::string MediaEngineRouter::ollama_tag_from_model_id(const std::string& model_id) {
  if (!is_ollama_model_id(model_id)) return model_id;
  return model_id.substr(model_id.find(':') + 1);
}

const char* MediaEngineRouter::engine_label(MediaEngine engine) {
  switch (engine) {
    case MediaEngine::OmegaEngine:
      return "engine";
    case MediaEngine::Ollama:
      return "ollama";
    case MediaEngine::Remote:
      return "remote";
    case MediaEngine::LegacyContentStudio:
      return "content_studio";
  }
  return "unknown";
}

bool MediaEngineRouter::native_engine_supports(MediaTask task) {
  return MediaExecutor::native_supports(task);
}

bool MediaEngineRouter::chat_model_supports_media(const std::string& model_id, MediaTask task) {
  if (model_id.empty() || is_remote_model_id(model_id)) return false;

  if (task == MediaTask::ImageGenerate) {
    if (is_ollama_model_id(model_id)) {
      const std::string tag = ollama_tag_from_model_id(model_id);
      return studio_media::looks_like_ollama_image_model(tag) && !looks_like_gguf_model(tag);
    }
    if (looks_like_diffusers_studio_pack(model_id)) return true;
    if (looks_like_gguf_model(model_id)) return false;
    if (!model_id.empty() && model_id.find('/') == std::string::npos && model_id.size() <= 48) {
      return studio_media::looks_like_ollama_image_model(model_id);
    }
    return native_engine_supports(MediaTask::ImageGenerate);
  }

  if (task == MediaTask::Tts) {
    if (looks_like_diffusers_studio_pack(model_id)) return true;
    const std::string id = lower(model_id);
    if (id.find("outetts") != std::string::npos) return true;
    if (id.find("qwen") != std::string::npos && id.find("tts") != std::string::npos) return true;
    if (looks_like_gguf_model(model_id)) return false;
    return native_engine_supports(MediaTask::Tts) &&
           (id.find("tts") != std::string::npos || id.find("outetts") != std::string::npos);
  }

  return false;
}

MediaEngine MediaEngineRouter::execution_engine(const MediaRoute& route, MediaTask task) {
  if (route.engine == MediaEngine::OmegaEngine && native_engine_supports(task)) {
    return MediaEngine::OmegaEngine;
  }
  if (route.fallback_engine) return *route.fallback_engine;
  return route.engine;
}

MediaRoute MediaEngineRouter::resolve(const std::string& model_id, MediaTask task,
                                      const nlohmann::json& config) {
  MediaRoute route;
  route.effective_model = model_id;
  route.ollama_fallback_model = config_ollama_image_model(config);

  if (is_remote_model_id(model_id)) {
    route.engine = MediaEngine::Remote;
    route.reason = "remote provider model";
    return route;
  }

  if (is_ollama_model_id(model_id)) {
    route.engine = MediaEngine::Ollama;
    route.effective_model = ollama_tag_from_model_id(model_id);
    route.reason = "explicit ollama: model id";
    return route;
  }

  switch (task) {
    case MediaTask::Chat:
    case MediaTask::Embed:
      route.engine = MediaEngine::OmegaEngine;
      route.effective_model =
          model_id.empty() ? config.value("defaultModel", "") : model_id;
      route.reason = "chat/embed → native omega-engine (llama.cpp)";
      return route;

    case MediaTask::ImageGenerate: {
      route.ollama_fallback_model = config_ollama_image_model(config);
      if (!chat_model_supports_media(model_id, MediaTask::ImageGenerate)) {
        route.engine = MediaEngine::LegacyContentStudio;
        route.reason = "chat model → Content Studio image role";
        return route;
      }
      if (looks_like_diffusers_studio_pack(model_id)) {
        route.engine = MediaEngine::LegacyContentStudio;
        route.reason = "studio image pack";
        return route;
      }
      if (is_ollama_model_id(model_id) ||
          (!looks_like_gguf_model(model_id) && !model_id.empty() &&
           model_id.find('/') == std::string::npos && model_id.size() <= 48)) {
        route.engine = MediaEngine::Ollama;
        route.effective_model = is_ollama_model_id(model_id)
                                    ? ollama_tag_from_model_id(model_id)
                                    : model_id;
        route.reason = "image-capable Ollama model";
        return route;
      }
      route.engine = MediaEngine::OmegaEngine;
      route.effective_model = config_native_image_model(model_id, config);
      route.reason = "native image model";
      return route;
    }

    case MediaTask::Tts: {
      if (!chat_model_supports_media(model_id, MediaTask::Tts)) {
        route.engine = MediaEngine::LegacyContentStudio;
        route.reason = "chat model → Content Studio TTS role";
        return route;
      }
      if (looks_like_diffusers_studio_pack(model_id)) {
        route.engine = MediaEngine::LegacyContentStudio;
        route.reason = "studio TTS pack";
        return route;
      }
      route.engine = MediaEngine::OmegaEngine;
      route.effective_model = config_native_tts_model(model_id, config);
      route.reason = "native TTS model";
      return route;
    }

    case MediaTask::VideoCompose:
      route.engine = MediaEngine::LegacyContentStudio;
      route.fallback_engine = std::nullopt;
      route.reason =
          "full studio pipeline (scenes, ffmpeg, publish) — native port in progress";
      if (!model_id.empty() && looks_like_gguf_model(model_id)) {
        route.effective_model = model_id;
      } else if (config.contains("defaultModel")) {
        route.effective_model = config.value("defaultModel", "");
      }
      return route;
  }

  route.engine = MediaEngine::OmegaEngine;
  route.reason = "default → native engine";
  return route;
}

}  // namespace omega::runtime
