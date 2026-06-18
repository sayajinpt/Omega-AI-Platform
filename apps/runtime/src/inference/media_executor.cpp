#include "omega/runtime/inference/media_executor.hpp"

#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/media/studio_media_runner.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <httplib.h>

#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <vector>

namespace fs = std::filesystem;

namespace omega::runtime {

namespace {

std::mutex g_caps_mu;
nlohmann::json g_caps = nlohmann::json::object();
std::chrono::steady_clock::time_point g_caps_at{};
constexpr auto k_caps_ttl = std::chrono::seconds(30);

bool decode_base64(const std::string& in, std::string& out) {
  static const char* k =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<int> T(256, -1);
  for (int i = 0; i < 64; ++i) T[static_cast<unsigned char>(k[i])] = i;
  out.clear();
  int val = 0, valb = -8;
  for (unsigned char c : in) {
    if (T[c] == -1) {
      if (c == '=') break;
      continue;
    }
    val = (val << 6) + T[c];
    valb += 6;
    if (valb >= 0) {
      out.push_back(static_cast<char>((val >> valb) & 0xFF));
      valb -= 8;
    }
  }
  return !out.empty();
}

std::string read_file_bytes(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

std::string lower_ascii(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool looks_like_gguf_id(const std::string& model_id) {
  const std::string id = lower_ascii(model_id);
  return id.find(".gguf") != std::string::npos || id.find("gguf") != std::string::npos;
}

bool looks_like_ollama_image_tag(const std::string& tag) {
  if (tag.empty() || looks_like_gguf_id(tag)) return false;
  if (studio_media::looks_like_studio_pack(tag)) return false;
  if (tag.find('/') != std::string::npos) return false;
  if (tag.size() > 48) return false;
  const std::string s = lower_ascii(tag);
  static const char* kHints[] = {"flux", "sdxl", "stable", "diffusion", "dalle", "image", "xl"};
  for (const char* hint : kHints) {
    if (s.find(hint) != std::string::npos) return true;
  }
  return studio_media::looks_like_ollama_image_model(tag);
}

std::vector<std::string> ollama_image_model_candidates(const nlohmann::json& config,
                                                       const MediaRoute& route) {
  std::vector<std::string> out;
  auto push = [&](const std::string& m) {
    if (m.empty() || looks_like_gguf_id(m) || !looks_like_ollama_image_tag(m)) return;
    for (const auto& x : out) {
      if (x == m) return;
    }
    out.push_back(m);
  };

  if (MediaEngineRouter::is_ollama_model_id(route.effective_model)) {
    push(MediaEngineRouter::ollama_tag_from_model_id(route.effective_model));
  } else {
    push(route.effective_model);
  }
  push(route.ollama_fallback_model);

  const auto img = config.value("imageGeneration", nlohmann::json::object());
  if (img.contains("ollamaModel") && img["ollamaModel"].is_string()) {
    push(img["ollamaModel"].get<std::string>());
  }
  push("flux");

  try {
    if (OllamaSupervisor::instance().ensure_started()) {
      const nlohmann::json models = OllamaSupervisor::instance().list_models();
      if (models.is_array()) {
        for (const auto& row : models) {
          push(row.value("name", ""));
        }
      }
    }
  } catch (...) {
  }

  return out;
}

ImageGenerateResult ollama_generate_image(const std::string& model, const std::string& prompt,
                                          int width, int height, bool as_fallback);

ImageGenerateResult try_ollama_image_chain(const nlohmann::json& config, const MediaRoute& route,
                                           const std::string& prompt, int width, int height,
                                           bool as_fallback) {
  ImageGenerateResult fail;
  std::string last_err;
  for (const std::string& model : ollama_image_model_candidates(config, route)) {
    ImageGenerateResult attempt =
        ollama_generate_image(model, prompt, width, height, as_fallback);
    if (attempt.ok) return attempt;
    last_err = attempt.error;
  }
  fail.error = last_err.empty()
                   ? "No image model is installed yet. Open Models and pull an image model "
                     "(for example flux), or add a Content Studio image pack for scene work."
                   : last_err;
  return fail;
}

ImageGenerateResult ollama_generate_image(const std::string& model, const std::string& prompt,
                                          int width, int height, bool as_fallback) {
  ImageGenerateResult result;
  result.ollama_fallback = as_fallback;
  try {
    auto& ollama = OllamaSupervisor::instance();
    if (!ollama.ensure_started()) {
      result.error =
          "Image generation needs an image model. Open Models and pull one (for example flux).";
      return result;
    }
    httplib::Client cli(ollama.base_url().c_str());
    cli.set_connection_timeout(10, 0);
    cli.set_read_timeout(300, 0);
    nlohmann::json body{{"model", model}, {"prompt", prompt}, {"stream", false}};
    if (width > 0 && height > 0) {
      body["options"] = nlohmann::json{{"width", width}, {"height", height}};
    }
    const auto res = cli.Post("/api/generate", body.dump(), "application/json");
    if (!res || res->status >= 400) {
      result.error = "Image model \"" + model +
                     "\" is not ready — open Models to download it, or try another image model.";
      return result;
    }
    const nlohmann::json parsed = nlohmann::json::parse(res->body);
    std::string bytes;
    if (parsed.contains("images") && parsed["images"].is_array() && !parsed["images"].empty()) {
      decode_base64(parsed["images"][0].get<std::string>(), bytes);
    } else if (parsed.contains("response") && parsed["response"].is_string()) {
      decode_base64(parsed["response"].get<std::string>(), bytes);
    }
    if (bytes.empty()) {
      result.error = "No image bytes in Ollama response";
      return result;
    }
    result.ok = true;
    result.backend = "ollama";
    result.png_bytes.assign(bytes.begin(), bytes.end());
    return result;
  } catch (const std::exception& e) {
    result.error = e.what();
    return result;
  }
}

std::string designated_studio_image_repo(const nlohmann::json& config) {
  static constexpr const char* kDefault = "cutycat2000/InterDiffusion-Nano";
  const nlohmann::json tools = config.value("omegaTools", nlohmann::json::object());
  std::string pin = tools.value("contentStudioImageRepoId", "");
  if (pin.empty()) {
    const fs::path gen_path = fs::path(omega_home()) / "content-studio-generation.json";
    if (fs::exists(gen_path)) {
      try {
        std::ifstream in(gen_path);
        const nlohmann::json g = nlohmann::json::parse(in);
        pin = g.value("imageRepoId", "");
      } catch (...) {
      }
    }
  }
  return pin.empty() ? kDefault : pin;
}

std::string designated_studio_tts_repo(const nlohmann::json& config) {
  static constexpr const char* kDefault = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice";
  const nlohmann::json tools = config.value("omegaTools", nlohmann::json::object());
  std::string pin = tools.value("contentStudioTtsRepoId", "");
  if (pin.empty()) {
    const fs::path gen_path = fs::path(omega_home()) / "content-studio-generation.json";
    if (fs::exists(gen_path)) {
      try {
        std::ifstream in(gen_path);
        const nlohmann::json g = nlohmann::json::parse(in);
        pin = g.value("ttsRepoId", "");
      } catch (...) {
      }
    }
  }
  return pin.empty() ? kDefault : pin;
}

ImageGenerateResult try_studio_chat_image(const nlohmann::json& config, const std::string& repo_id,
                                          const std::string& prompt, int width, int height) {
  ImageGenerateResult result;
  result.studio_fallback = true;
  (void)config;
  if (!studio_media::subprocess_ready()) {
    result.error =
        "Content Studio image tools are not ready. Install an image pack from Models → Model roles.";
    return result;
  }

  const fs::path tmp_dir = fs::path(omega_home()) / "content-studio" / "tmp" / "chat-media";
  fs::create_directories(tmp_dir);
  const fs::path out_png = tmp_dir / ("chat_img_" + random_uuid().substr(0, 8) + ".png");

  const nlohmann::json req{{"phase", "chat_image"},
                           {"prompt", prompt},
                           {"out_path", out_png.string()},
                           {"hf_image_repo_id", repo_id},
                           {"width", width},
                           {"height", height}};
  const studio_media::PhaseResult phase = studio_media::run_phase("chat_image", req);
  if (!phase.ok) {
    std::string err = phase.error.empty()
                          ? "Could not generate an image with your Content Studio image model. "
                            "Install it from Models → Model roles."
                          : phase.error;
    const bool cuda_hint =
        err.find("cuda") != std::string::npos || err.find("CUDA") != std::string::npos;
    if (cuda_hint) {
      err +=
          " On AMD/Intel PCs, the Vulkan Omega build accelerates chat models only — image "
          "generation uses PyTorch (CUDA on NVIDIA, or CPU/DirectML). Re-run Python setup from "
          "Settings after updating Omega.";
    }
    result.error = err;
    return result;
  }

  const std::string bytes = read_file_bytes(out_png.string());
  if (bytes.empty()) {
    result.error = "Image generation finished but produced no file.";
    return result;
  }

  result.ok = true;
  result.backend = "content_studio";
  result.png_bytes.assign(bytes.begin(), bytes.end());
  return result;
}

TtsGenerateResult try_studio_chat_tts(const nlohmann::json& config, const std::string& repo_id,
                                      const std::string& text, const std::string& out_path,
                                      const TtsSynthesisOptions& options) {
  TtsGenerateResult result;
  result.studio_fallback = true;
  if (!studio_media::subprocess_ready()) {
    result.error =
        "Content Studio voice tools are not ready. Install a TTS pack from Models → Model roles.";
    return result;
  }

  const nlohmann::json tts_cfg = config.value("ttsGeneration", nlohmann::json::object());
  std::string speaker = options.speaker.empty() ? tts_cfg.value("speaker", "Ryan") : options.speaker;
  std::string language =
      options.language.empty() ? tts_cfg.value("language", "English") : options.language;
  nlohmann::json req{{"phase", "chat_tts"},
                     {"text", text},
                     {"out_path", out_path},
                     {"hf_tts_repo_id", repo_id},
                     {"tts_speaker", speaker},
                     {"tts_language", language},
                     {"tts_voice_gender", options.voice_gender.empty() ? "any" : options.voice_gender}};
  if (!options.instruct.empty()) req["tts_instruct"] = options.instruct;
  const studio_media::PhaseResult phase = studio_media::run_phase("chat_tts", req);
  if (!phase.ok) {
    result.error = phase.error.empty()
                       ? "Could not synthesize speech with your Content Studio voice model. "
                         "Install it from Models → Model roles."
                       : phase.error;
    return result;
  }

  if (!fs::exists(out_path) || fs::file_size(out_path) == 0) {
    result.error = "Speech synthesis finished but produced no audio file.";
    return result;
  }

  result.ok = true;
  result.backend = "content_studio";
  result.wav_path = out_path;
  return result;
}

ImageGenerateResult generate_with_capable_chat_model(EngineClient* engine, const nlohmann::json& config,
                                                   const std::string& chat_model,
                                                   const std::string& prompt, int width,
                                                   int height) {
  ImageGenerateResult fail;
  const MediaRoute route =
      MediaEngineRouter::resolve(chat_model, MediaTask::ImageGenerate, config);

  if (route.engine == MediaEngine::LegacyContentStudio) {
    const std::string repo = studio_media::looks_like_studio_pack(chat_model)
                                 ? chat_model
                                 : designated_studio_image_repo(config);
    return try_studio_chat_image(config, repo, prompt, width, height);
  }

  const MediaEngine backend =
      MediaEngineRouter::execution_engine(route, MediaTask::ImageGenerate);

  if (backend == MediaEngine::OmegaEngine && engine &&
      MediaExecutor::native_supports(MediaTask::ImageGenerate)) {
    try {
      engine->ensure_started();
      const nlohmann::json payload{{"prompt", prompt},
                                   {"modelId", route.effective_model},
                                   {"width", width},
                                   {"height", height},
                                   {"allowOllama", true},
                                   {"ollamaModel", route.ollama_fallback_model}};
      const nlohmann::json data = engine->command("image.generate", payload, 300000);
      std::string bytes;
      if (data.contains("pngBase64") && data["pngBase64"].is_string()) {
        decode_base64(data["pngBase64"].get<std::string>(), bytes);
      } else if (data.contains("path") && data["path"].is_string()) {
        bytes = read_file_bytes(data["path"].get<std::string>());
      }
      if (!bytes.empty()) {
        ImageGenerateResult ok;
        ok.ok = true;
        ok.backend = data.value("backend", "engine");
        ok.png_bytes.assign(bytes.begin(), bytes.end());
        return ok;
      }
    } catch (...) {
    }
  }

  if (backend == MediaEngine::Ollama) {
    ImageGenerateResult ollama =
        try_ollama_image_chain(config, route, prompt, width, height, false);
    if (ollama.ok) return ollama;
    fail.error = ollama.error;
    return fail;
  }

  fail.error = "The loaded model could not generate an image.";
  return fail;
}

}  // namespace

void MediaExecutor::refresh_capabilities(EngineClient& engine) {
  const auto now = std::chrono::steady_clock::now();
  {
    std::lock_guard lock(g_caps_mu);
    if (!g_caps.empty() && (now - g_caps_at) < k_caps_ttl) return;
  }

  nlohmann::json caps{{"imageGenerate", false},
                      {"ttsGenerate", false},
                      {"vision", false},
                      {"engineAvailable", engine.available()}};

  if (engine.available()) {
    try {
      engine.ensure_started();
      const nlohmann::json data = engine.command("media.capabilities", nlohmann::json::object(), 8000);
      caps = data;
      caps["engineAvailable"] = true;
    } catch (...) {
      caps["engineAvailable"] = true;
      caps["capabilitiesError"] = true;
    }
  }

  std::lock_guard lock(g_caps_mu);
  g_caps = std::move(caps);
  g_caps_at = now;
}

nlohmann::json MediaExecutor::capabilities_json() {
  std::lock_guard lock(g_caps_mu);
  if (g_caps.empty()) {
    return nlohmann::json{{"imageGenerate", false},
                          {"ttsGenerate", false},
                          {"vision", false},
                          {"stale", true}};
  }
  return g_caps;
}

bool MediaExecutor::native_supports(MediaTask task) {
  switch (task) {
    case MediaTask::Chat:
    case MediaTask::Embed:
      return true;
    case MediaTask::VideoCompose:
      return false;
    case MediaTask::ImageGenerate:
    case MediaTask::Tts: {
      std::lock_guard lock(g_caps_mu);
      if (g_caps.empty()) return false;
      if (task == MediaTask::ImageGenerate) return g_caps.value("imageGenerate", false);
      return g_caps.value("ttsGenerate", false);
    }
  }
  return false;
}

ImageGenerateResult MediaExecutor::generate_image(EngineClient* engine,
                                                  const nlohmann::json& config,
                                                  const std::string& model_id,
                                                  const std::string& prompt, int width,
                                                  int height) {
  ImageGenerateResult fail;
  if (engine) refresh_capabilities(*engine);

  const std::string chat_model =
      !model_id.empty() ? model_id : config.value("defaultModel", "");
  if (MediaEngineRouter::is_remote_model_id(chat_model)) {
    fail.error = "Cloud image generation is not available on this device yet.";
    return fail;
  }

  if (!chat_model.empty() &&
      MediaEngineRouter::chat_model_supports_media(chat_model, MediaTask::ImageGenerate)) {
    return generate_with_capable_chat_model(engine, config, chat_model, prompt, width, height);
  }

  return try_studio_chat_image(config, designated_studio_image_repo(config), prompt, width,
                               height);
}

TtsGenerateResult MediaExecutor::generate_tts(EngineClient* engine, const nlohmann::json& config,
                                              const std::string& model_id, const std::string& text,
                                              const std::string& out_path,
                                              const TtsSynthesisOptions& options) {
  TtsGenerateResult fail;
  if (engine) refresh_capabilities(*engine);

  const std::string chat_model =
      !model_id.empty() ? model_id : config.value("defaultModel", "");

  if (!chat_model.empty() && MediaEngineRouter::chat_model_supports_media(chat_model, MediaTask::Tts)) {
    const MediaRoute route = MediaEngineRouter::resolve(chat_model, MediaTask::Tts, config);
    if (route.engine == MediaEngine::LegacyContentStudio) {
      const std::string repo =
          studio_media::looks_like_studio_pack(chat_model) ? chat_model : designated_studio_tts_repo(config);
      return try_studio_chat_tts(config, repo, text, out_path, options);
    }
    if (engine) {
      engine->ensure_started();
      const std::vector<std::string> model_attempts =
          route.effective_model.empty() ? std::vector<std::string>{""}
                                        : std::vector<std::string>{route.effective_model, ""};
      for (const std::string& model_id_attempt : model_attempts) {
        try {
          nlohmann::json payload{{"text", text}, {"outPath", out_path}};
          if (!model_id_attempt.empty()) payload["modelId"] = model_id_attempt;
          const nlohmann::json data = engine->command("tts.generate", payload, 300000);
          if (data.value("ok", false) && data.contains("wavPath")) {
            TtsGenerateResult ok;
            ok.ok = true;
            ok.backend = "engine";
            ok.wav_path = data["wavPath"].get<std::string>();
            return ok;
          }
        } catch (...) {
        }
      }
    }
    fail.error = "The loaded model could not synthesize speech.";
    return fail;
  }

  return try_studio_chat_tts(config, designated_studio_tts_repo(config), text, out_path, options);
}

std::string MediaExecutor::designated_studio_video_repo(const nlohmann::json& config) {
  const nlohmann::json tools = config.value("omegaTools", nlohmann::json::object());
  std::string pin = tools.value("contentStudioVideoRepoId", "");
  if (pin.empty()) {
    const fs::path gen_path = fs::path(omega_home()) / "content-studio-generation.json";
    if (fs::exists(gen_path)) {
      try {
        std::ifstream in(gen_path);
        const nlohmann::json g = nlohmann::json::parse(in);
        pin = g.value("videoRepoId", "");
      } catch (...) {
      }
    }
  }
  return pin;
}

bool MediaExecutor::video_model_ready(const nlohmann::json& config) {
  const std::string pin = designated_studio_video_repo(config);
  if (!pin.empty()) {
    return ContentStudioSettings::model_installed("video", pin);
  }
  return ContentStudioSettings::any_video_model_installed();
}

VideoGenerateResult try_studio_chat_video(const nlohmann::json& config, const std::string& repo_id,
                                          const std::string& prompt, const std::string& out_path,
                                          const std::string& negative_prompt,
                                          bool prefer_full_gpu, int max_duration_seconds) {
  VideoGenerateResult result;
  result.studio_fallback = true;
  (void)config;
  if (!studio_media::subprocess_ready()) {
    result.error =
        "Video generation tools are not ready. Install a text-to-video pack from Models → Model roles.";
    return result;
  }

  nlohmann::json req{{"phase", "chat_video"},
                     {"prompt", prompt},
                     {"out_path", out_path},
                     {"hf_video_repo_id", repo_id}};
  if (!negative_prompt.empty()) req["negative_prompt"] = negative_prompt;
  if (prefer_full_gpu) req["prefer_full_gpu"] = true;
  if (max_duration_seconds > 0) req["max_duration_seconds"] = max_duration_seconds;

  const studio_media::PhaseResult phase = studio_media::run_phase("chat_video", req);
  if (!phase.ok) {
    result.error = phase.error.empty()
                         ? "Could not generate video with your designated video model. "
                           "Install it from Models → Model roles → Video."
                         : phase.error;
    return result;
  }

  if (!fs::exists(out_path) || fs::file_size(out_path) == 0) {
    result.error = "Video generation finished but produced no file.";
    return result;
  }

  result.ok = true;
  result.backend = "content_studio";
  result.mp4_path = out_path;
  return result;
}

VideoGenerateResult MediaExecutor::generate_video(const nlohmann::json& config,
                                                  const std::string& prompt,
                                                  const std::string& out_path,
                                                  const std::string& negative_prompt,
                                                  const bool prefer_full_gpu,
                                                  const int max_duration_seconds) {
  VideoGenerateResult fail;
  if (prompt.empty()) {
    fail.error = "Video prompt is empty.";
    return fail;
  }
  if (!video_model_ready(config)) {
    const std::string repo = designated_studio_video_repo(config);
    if (!repo.empty()) {
      fail.error = "Video model «" + repo +
                   "» is not installed. Download it from Models → Model roles → Video.";
    } else {
      fail.error =
          "No text-to-video model is installed. Download any diffusers T2V repo from "
          "Models → Model roles → Video (or pin one in Model roles).";
    }
    return fail;
  }
  return try_studio_chat_video(config, designated_studio_video_repo(config), prompt, out_path,
                               negative_prompt, prefer_full_gpu, max_duration_seconds);
}

}  // namespace omega::runtime
