#include "omega/runtime/media/content_studio_native_media.hpp"

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/media_engine_router.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/media/ffmpeg_compose.hpp"
#include "omega/runtime/media/studio_media_runner.hpp"
#include "omega/runtime/paths.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime::content_studio_native {

namespace {

bool json_bool_field(const json& j, const char* key, bool fallback) {
  if (!j.is_object() || !j.contains(key) || j[key].is_null()) return fallback;
  if (j[key].is_boolean()) return j[key].get<bool>();
  return fallback;
}

std::vector<json> sorted_scenes(const json& script) {
  std::vector<json> scenes;
  if (!script.contains("scenes") || !script["scenes"].is_array()) return scenes;
  for (const auto& sc : script["scenes"]) scenes.push_back(sc);
  std::sort(scenes.begin(), scenes.end(), [](const json& a, const json& b) {
    return a.value("scene_number", 0) < b.value("scene_number", 0);
  });
  return scenes;
}

bool write_placeholder_png(const fs::path& out, int width, int height) {
  const std::string ffmpeg = ffmpeg_media::find_ffmpeg();
  if (ffmpeg.empty()) return false;
  fs::create_directories(out.parent_path());
  std::ostringstream cmd;
  cmd << "\"" << ffmpeg << "\" -y -f lavfi -i color=c=0x1a1a1a:s=" << width << "x" << height
      << " -frames:v 1 \"" << out.string() << "\" 2>nul";
  const std::string cmd_s = cmd.str();
  return std::system(cmd_s.c_str()) == 0 && fs::exists(out);
}

std::pair<int, int> dims_from_brief(const json& brief) {
  const std::string aspect = brief.value("aspect_ratio", "16:9");
  if (aspect == "9:16" || aspect == "vertical") return {720, 1280};
  return {1280, 720};
}

fs::path content_storage_root(const json& body) {
  if (body.contains("storage_path") && body["storage_path"].is_string()) {
    const std::string custom = body["storage_path"].get<std::string>();
    if (!custom.empty()) return fs::path(custom);
  }
  return fs::path(resolve_content_studio_storage());
}

}  // namespace

bool should_use_native_media(const json& payload, const std::string& hf_tts_repo,
                             const std::string& hf_image_repo, bool no_image_mode) {
  if (payload.contains("use_native_media") && payload["use_native_media"].is_boolean()) {
    return payload["use_native_media"].get<bool>();
  }
  if (const char* env = std::getenv("OMEGA_NATIVE_MEDIA")) {
    if (env[0] == '0' && env[1] == '\0') return false;
    if (std::string(env) == "false" || std::string(env) == "0") return false;
  }
  (void)hf_tts_repo;
  (void)hf_image_repo;
  (void)no_image_mode;
  return true;
}

json run_production_bundle(ConfigStore& config, EngineClient& engine, const json& body) {
  const std::string project_id = body.value("project_id", body.value("projectId", ""));
  const std::string job_id = body.value("job_id", body.value("jobId", ""));
  const json script = body.value("script_content", body.value("scriptContent", json::object()));
  const json brief = body.value("brief_json", body.value("briefJson", json::object()));
  const bool no_image = json_bool_field(body, "no_image_mode", json_bool_field(body, "noImageMode", false));
  const bool include_subtitles =
      json_bool_field(body, "include_subtitles", json_bool_field(brief, "include_subtitles", false));
  const std::string deliverable = body.value("deliverable", "video");
  const bool image_only = deliverable == "image_only";
  const bool audio_only = deliverable == "audio_only";

  if (project_id.empty() || job_id.empty()) {
    return json{{"ok", false}, {"error", "project_id and job_id required"}};
  }

  const auto scenes = sorted_scenes(script);
  if (scenes.empty()) {
    return json{{"ok", false}, {"error", "script has no scenes"}};
  }

  const fs::path job_root = content_storage_root(body) / project_id / job_id;
  const fs::path images_dir = job_root / "images";
  const fs::path audio_dir = job_root / "audio";
  fs::create_directories(images_dir);
  fs::create_directories(audio_dir);

  const json cfg = config.load();
  const json img_cfg = cfg.value("imageGeneration", json::object());
  const int width = img_cfg.value("width", 1024);
  const int height = img_cfg.value("height", 1024);
  const auto [tw, th] = dims_from_brief(brief);

  const std::string image_model = body.value("hf_image_repo_id", body.value("imageModelId", ""));
  const std::string tts_model = body.value("hf_tts_repo_id", body.value("ttsModelId", ""));

  json log = json::array();
  auto push_log = [&](const std::string& level, const std::string& msg) {
    log.push_back(json{{"level", level}, {"message", msg}});
  };

  const bool use_ollama_images =
      json_bool_field(body, "use_ollama_images", json_bool_field(img_cfg, "useOllama", false));
  const bool ollama_image_path =
      !no_image && !audio_only && use_ollama_images &&
      (MediaEngineRouter::is_ollama_model_id(image_model) ||
       studio_media::looks_like_ollama_image_model(image_model));
  const bool studio_images = !no_image && !audio_only && !ollama_image_path;
  const bool studio_tts =
      !image_only && (tts_model.empty() || studio_media::looks_like_studio_pack(tts_model));
  const std::string no_image_theme =
      body.value("no_image_theme", body.value("noImageTheme", "dark"));

  push_log("info", ollama_image_path
                        ? "Native media pipeline (Ollama images → engine TTS / studio TTS → ffmpeg)"
                        : studio_images || studio_tts
                              ? "Native media pipeline (studio subprocesses / engine → ffmpeg)"
                              : "Native media pipeline (omega-engine TTS → ffmpeg)");

  MediaExecutor::refresh_capabilities(engine);

  auto run_studio_images_phase = [&](const std::string& log_label) -> bool {
    push_log("info", log_label);
    json phase_req = body;
    if (!image_model.empty()) phase_req["hf_image_repo_id"] = image_model;
    const auto phase = studio_media::run_phase("images", phase_req);
    if (!phase.ok) {
      push_log("error", phase.error);
      return false;
    }
    push_log("info", phase.summary.empty() ? "Scene images complete" : phase.summary);
    return true;
  };

  if (!no_image && !audio_only) {
    if (studio_images) {
      if (!run_studio_images_phase("Phase: scene images (Content Studio diffusers subprocess)")) {
        return json{{"ok", false}, {"error", "studio image phase failed"}, {"log", log}};
      }
    } else if (ollama_image_path) {
      push_log("info", "Phase: scene images (Ollama — imageGeneration.useOllama)");
      try {
        if (!OllamaSupervisor::instance().ensure_started()) {
          push_log("warning", "Ollama did not start — scene images may use placeholders only");
        }
      } catch (...) {
        push_log("warning", "Ollama unavailable for scene images");
      }
      int scenes_with_prompt = 0;
      int engine_images_ok = 0;
      for (size_t i = 0; i < scenes.size(); ++i) {
        const json& sc = scenes[i];
        const int sn = sc.value("scene_number", static_cast<int>(i + 1));
        char name_buf[32];
        std::snprintf(name_buf, sizeof(name_buf), "scene_%02d", sn);
        const fs::path png = images_dir / (std::string(name_buf) + ".png");

        const std::string prompt = sc.value("image_prompt", sc.value("imagePrompt", ""));
        if (prompt.empty()) {
          if (!write_placeholder_png(png, tw, th)) {
            return json{{"ok", false},
                        {"error", "missing image_prompt and placeholder failed"},
                        {"log", log}};
          }
          continue;
        }
        ++scenes_with_prompt;

        const ImageGenerateResult img =
            MediaExecutor::generate_image(&engine, cfg, image_model, prompt, width, height);
        if (!img.ok) {
          push_log("warning", "Scene " + std::to_string(sn) + " image: " + img.error);
          if (!write_placeholder_png(png, tw, th)) {
            return json{{"ok", false}, {"error", img.error}, {"log", log}};
          }
          continue;
        }
        std::ofstream out(png, std::ios::binary);
        out.write(reinterpret_cast<const char*>(img.png_bytes.data()),
                  static_cast<std::streamsize>(img.png_bytes.size()));
        ++engine_images_ok;
        push_log("info", "Scene " + std::to_string(sn) + " image (" + img.backend +
                             (img.ollama_fallback ? ", Ollama fallback" : "") + ")");
      }

      if (scenes_with_prompt > 0 && engine_images_ok == 0) {
        push_log("warning",
                 "Ollama produced no scene images — retrying with Content Studio diffusers subprocess");
        if (!run_studio_images_phase("Phase: scene images (studio subprocess fallback)")) {
          push_log("warning",
                   "Studio image fallback failed — continuing with gray placeholders for ffmpeg");
        }
      }
    }
  } else if (no_image && !audio_only) {
    push_log("info", "Phase: subtitle frames (no-image mode)");
    json phase_req = body;
    phase_req["no_image_theme"] = no_image_theme;
    const auto phase = studio_media::run_phase("subtitle_frames", phase_req);
    if (!phase.ok) {
      push_log("warning", "Subtitle frames subprocess failed — gray placeholders (" + phase.error + ")");
      for (size_t i = 0; i < scenes.size(); ++i) {
        const int sn = scenes[i].value("scene_number", static_cast<int>(i + 1));
        char name_buf[32];
        std::snprintf(name_buf, sizeof(name_buf), "scene_%02d", sn);
        write_placeholder_png(images_dir / (std::string(name_buf) + ".png"), tw, th);
      }
    } else {
      push_log("info", phase.summary.empty() ? "Subtitle frames complete" : phase.summary);
    }
  }

  if (image_only) {
    return json{{"ok", true},
                {"summary", "Native image-only deliverable"},
                {"log", log}};
  }

  if (studio_tts) {
    push_log("info", "Phase: TTS (Content Studio Qwen subprocess)");
    json phase_req = body;
    phase_req["hf_tts_repo_id"] = tts_model;
    const auto phase = studio_media::run_phase("tts", phase_req);
    if (!phase.ok) {
      return json{{"ok", false}, {"error", phase.error}, {"log", log}};
    }
    push_log("info", phase.summary.empty() ? "TTS complete" : phase.summary);
  } else {
    push_log("info", "Phase: TTS (llama.cpp / engine)");
    for (size_t i = 0; i < scenes.size(); ++i) {
      const json& sc = scenes[i];
      const int sn = sc.value("scene_number", static_cast<int>(i + 1));
      char name_buf[32];
      std::snprintf(name_buf, sizeof(name_buf), "scene_%02d", sn);
      const fs::path wav = audio_dir / (std::string(name_buf) + ".wav");

      std::string text = sc.value("narration_text", sc.value("narrationText", ""));
      if (text.empty()) text = "Scene " + std::to_string(sn);

      TtsGenerateResult tts =
          MediaExecutor::generate_tts(&engine, cfg, tts_model, text, wav.string());
      if (!tts.ok) {
        const double dur = sc.value("duration_seconds", sc.value("durationSeconds", 3.0));
        if (ffmpeg_media::write_silent_wav(wav, dur)) {
          push_log("warning",
                   "Scene " + std::to_string(sn) + " TTS failed — silent placeholder (" +
                       tts.error + ")");
        } else {
          push_log("error", "Scene " + std::to_string(sn) + " TTS: " + tts.error);
          return json{{"ok", false}, {"error", tts.error}, {"log", log}};
        }
      } else {
        push_log("info", "Scene " + std::to_string(sn) + " TTS (" + tts.backend + ")");
      }
    }

    const int silent_after_engine =
        ffmpeg_media::count_nearly_silent_scene_wavs(audio_dir, scenes);
    if (silent_after_engine >= static_cast<int>(scenes.size())) {
      push_log("warning",
               "Engine TTS produced only silent narration — retrying with Content Studio Qwen subprocess");
      json phase_req = body;
      if (!tts_model.empty()) phase_req["hf_tts_repo_id"] = tts_model;
      const auto fallback = studio_media::run_phase("tts", phase_req);
      if (!fallback.ok) {
        push_log("warning", "Studio TTS fallback failed: " + fallback.error);
      } else {
        push_log("info", fallback.summary.empty() ? "Studio TTS fallback complete" : fallback.summary);
      }
    } else if (silent_after_engine > 0) {
      push_log("warning", std::to_string(silent_after_engine) + " scene WAV(s) are nearly silent");
    }
  }

  if (audio_only) {
    return json{{"ok", true},
                {"summary", "Native audio-only deliverable"},
                {"log", log}};
  }

  const int silent_before_compose =
      ffmpeg_media::count_nearly_silent_scene_wavs(audio_dir, scenes);
  if (silent_before_compose >= static_cast<int>(scenes.size())) {
    push_log("error",
             "TTS produced only silent narration WAVs — MP4 will have little or no audible audio. "
             "Install a TTS model in Settings → Omega tools and check job logs.");
  } else if (silent_before_compose > 0) {
    push_log("warning",
             std::to_string(silent_before_compose) + " scene WAV(s) are nearly silent before ffmpeg");
  }

  push_log("info", "Phase: ffmpeg compose");
  std::string ff_err;
  const fs::path mp4 =
      ffmpeg_media::assemble_final_mp4(job_root, script, brief, ff_err, include_subtitles);
  if (mp4.empty()) {
    return json{{"ok", false}, {"error", ff_err}, {"log", log}};
  }

  double dur = ffmpeg_media::probe_duration_seconds(mp4);
  std::string rel;
  try {
    rel = fs::relative(mp4, content_storage_root(body)).lexically_normal().string();
    for (char& c : rel) {
      if (c == '\\') c = '/';
    }
  } catch (...) {
    rel = mp4.string();
  }

  push_log("info", "Rendered " + std::to_string(static_cast<int>(dur)) + "s MP4 → " + rel);
  return json{{"ok", true},
              {"summary", "Native render complete"},
              {"mp4Path", mp4.string()},
              {"relativePath", rel},
              {"durationSeconds", static_cast<int>(dur)},
              {"log", log}};
}

}  // namespace omega::runtime::content_studio_native
