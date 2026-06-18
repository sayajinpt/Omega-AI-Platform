#include "omega/runtime/services/content_studio_orchestrator.hpp"

#include "omega/runtime/debug_log.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/services/debug_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/services/content_job_delivery_service.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/services/pipeline_activity.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/tools/sandbox.hpp"
#include "omega/runtime/inference/chat_usage.hpp"
#include "omega/runtime/chat/model_gate.hpp"
#include "omega/runtime/inference/model_load_payload.hpp"
#include "omega/runtime/util/context_trim.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <set>
#include <cctype>
#include <cstdlib>
#include <array>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

void ContentStudioOrchestrator::attach_debug(DebugStore* debug) { debug_ = debug; }

void ContentStudioOrchestrator::cs_log(const std::string& message, const std::string& level,
                                       const json& data) const {
  emit_debug(debug_, "orchestrator", message, level, data);
}

namespace {

std::string arg_str(const std::map<std::string, std::string>& args, const std::string& key,
                    const std::string& fallback = "") {
  const auto it = args.find(key);
  if (it != args.end() && !it->second.empty()) return it->second;
  return fallback;
}

bool arg_bool(const std::map<std::string, std::string>& args, const std::string& key,
              bool fallback = false) {
  const std::string v = arg_str(args, key);
  if (v.empty()) return fallback;
  const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(v[0])));
  return v == "1" || v == "true" || v == "yes" || c == 't' || c == 'y';
}

int arg_int(const std::map<std::string, std::string>& args, const std::string& key, int fallback) {
  const std::string v = arg_str(args, key);
  if (v.empty()) return fallback;
  try {
    return std::stoi(v);
  } catch (...) {
    return fallback;
  }
}

void put_if(json& body, const char* key, const std::map<std::string, std::string>& args,
            const char* arg_key) {
  const std::string v = arg_str(args, arg_key);
  if (!v.empty()) body[key] = v;
}

void put_int_if(json& body, const char* key, const std::map<std::string, std::string>& args,
                const char* arg_key) {
  const std::string v = arg_str(args, arg_key);
  if (v.empty()) return;
  try {
    body[key] = std::stoi(v);
  } catch (...) {
  }
}

constexpr const char* kScriptSystemPrompt = R"(Write one Content Studio video script as JSON only (no markdown).

{"title":"...","description":"...","scenes":[{"duration_seconds":N,"narration_text":"...","image_prompt":"...","transition":"fade","text_overlays":[]}]}

Rules: scenes match SCENE PLAN count and per-scene seconds; non-empty narration_text and image_prompt; narration_text is exact TTS words.)";

constexpr const char* kT2vSystemPrompt = R"(You write a single text-to-video prompt for a diffusers T2V model.

Respond with ONE JSON object only — no markdown fences, no prose before or after.

Schema:
{
  "title": "short clip title",
  "prompt": "detailed cinematic description with subject, motion, camera, lighting",
  "negative_prompt": "optional things to avoid"
}

Hard rules:
- prompt must describe visible motion and scene action (not a script with dialogue).
- Keep prompt concise (~80 words / under 128 T5 tokens); concrete visual language only.
- negative_prompt should list artifacts to avoid (blur, jitter, distortion).)";

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

fs::path content_storage_root() { return fs::path(omega_home()) / "content-studio" / "storage"; }

fs::path content_pending_path(const std::string& session_id) {
  return fs::path(omega_home()) / "content-studio" / "pending" / (session_id + ".json");
}

uintmax_t dir_size(const fs::path& root) {
  uintmax_t total = 0;
  std::error_code ec;
  for (fs::recursive_directory_iterator it(root, ec), end; it != end; it.increment(ec)) {
    if (ec) break;
    if (it->is_regular_file(ec)) total += it->file_size(ec);
  }
  return total;
}

json tool_result_json(const ToolResult& r) {
  json out{{"ok", r.ok}, {"output", r.output}};
  if (!r.parts.empty()) out["parts"] = r.parts;
  return out;
}

void trim_text_to_token_budget(std::string& text, int token_budget) {
  const int max_chars = std::max(0, token_budget * 4);
  if (static_cast<int>(text.size()) <= max_chars) return;
  text.resize(static_cast<size_t>(max_chars));
  text += "\n\n[… truncated for context limit]";
}

std::string preview_text(const std::string& text, size_t max_len = 280) {
  if (text.size() <= max_len) return text;
  return text.substr(0, max_len) + "…";
}

void erase_between(std::string& text, const std::string& open, const std::string& close) {
  for (;;) {
    const auto start = text.find(open);
    if (start == std::string::npos) return;
    const auto content_start = start + open.size();
    const auto end = text.find(close, content_start);
    if (end == std::string::npos) {
      text.erase(start);
      return;
    }
    text.erase(start, end + close.size() - start);
  }
}

std::string strip_model_reasoning_markup(std::string text) {
  static const std::array<std::pair<const char*, const char*>, 5> kPairs = {{
      {"<think>", "</think>"},
      {"<" "think" ">", "</" "think" ">"},
      {"<|think|>", "</|think|>"},
      {"<seed:think|>", "</seed:think|>"},
      {"[THINK]", "[/THINK]"},
  }};
  for (const auto& [open, close] : kPairs) erase_between(text, open, close);
  const std::string empty_think = "<think></think>";
  for (;;) {
    const auto pos = text.find(empty_think);
    if (pos == std::string::npos) break;
    text.erase(pos, empty_think.size());
  }
  return text;
}

std::optional<json> unwrap_script_envelope(const json& obj) {
  if (obj.contains("scenes") && obj["scenes"].is_array()) return obj;
  for (const char* key : {"result", "output", "script", "data", "response"}) {
    if (!obj.contains(key)) continue;
    if (obj[key].is_object()) {
      const json inner = obj[key];
      if (inner.contains("scenes") && inner["scenes"].is_array()) return inner;
    }
    if (obj[key].is_string()) {
      const std::string nested = obj[key].get<std::string>();
      if (nested.find('{') != std::string::npos) {
        try {
          const json inner = json::parse(nested);
          if (inner.is_object()) {
            if (auto unwrapped = unwrap_script_envelope(inner)) return unwrapped;
          }
        } catch (...) {
        }
      }
    }
  }
  return std::nullopt;
}

int score_script_candidate(const json& obj) {
  if (!obj.contains("scenes") || !obj["scenes"].is_array()) return -1;
  int score = static_cast<int>(obj["scenes"].size()) * 1000;
  for (const auto& scene : obj["scenes"]) {
    if (!scene.is_object()) continue;
    if (scene.contains("narration_text") && scene["narration_text"].is_string() &&
        !scene["narration_text"].get<std::string>().empty()) {
      score += 10;
    }
    if (scene.contains("image_prompt") && scene["image_prompt"].is_string() &&
        !scene["image_prompt"].get<std::string>().empty()) {
      score += 10;
    }
  }
  return score;
}

std::optional<json> extract_script_json_object(const std::string& raw) {
  std::string text = strip_model_reasoning_markup(raw);
  text = strip_model_reasoning_markup(text);
  if (const auto fence = text.find("```"); fence != std::string::npos) {
    const auto start = text.find('\n', fence);
    const auto end = text.find("```", start == std::string::npos ? fence + 3 : start + 1);
    if (start != std::string::npos && end != std::string::npos && end > start) {
      text = text.substr(start + 1, end - start - 1);
    }
  }
  text = strip_model_reasoning_markup(text);

  const auto trimmed = [&text]() {
    size_t begin = 0;
    while (begin < text.size() && std::isspace(static_cast<unsigned char>(text[begin]))) ++begin;
    size_t end = text.size();
    while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1]))) --end;
    return text.substr(begin, end - begin);
  }();

  if (!trimmed.empty() && trimmed.front() == '[') {
    try {
      const json arr = json::parse(trimmed);
      if (arr.is_array() && !arr.empty() && arr.front().is_object()) {
        if (auto unwrapped = unwrap_script_envelope(arr.front())) return unwrapped;
      }
    } catch (...) {
    }
  }

  std::optional<json> best;
  int best_score = -1;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] != '{') continue;
    try {
      const json parsed = json::parse(text.begin() + static_cast<std::ptrdiff_t>(i), text.end());
      if (!parsed.is_object()) continue;
      if (auto unwrapped = unwrap_script_envelope(parsed)) {
        const int score = score_script_candidate(*unwrapped);
        if (score > best_score) {
          best_score = score;
          best = unwrapped;
        }
      }
    } catch (...) {
    }
  }
  return best;
}

json fit_content_studio_chat_payload(ConfigStore* config, EngineClient* engine,
                                     const std::string& model, std::string system_content,
                                     std::string user_content, int requested_max_tokens) {
  const int ctx =
      (config && engine) ? resolve_effective_context_size(*config, *engine, model) : 8192;
  const int overhead = chat_template_overhead_tokens(false);
  const int min_gen = 256;
  const int max_prompt = std::max(256, ctx - overhead - min_gen);

  int user_t = estimate_tokens(user_content);
  int sys_t = estimate_tokens(system_content);
  if (user_t + sys_t + overhead > max_prompt) {
    if (user_t > max_prompt / 4) {
      trim_text_to_token_budget(user_content, max_prompt / 4);
      user_t = estimate_tokens(user_content);
    }
    const int sys_budget = std::max(128, max_prompt - user_t);
    trim_text_to_token_budget(system_content, sys_budget);
    sys_t = estimate_tokens(system_content);
  }

  const int prompt_est = user_t + sys_t + overhead;
  const int max_tokens = compute_generation_max_tokens(ctx, prompt_est, requested_max_tokens);

  json messages = json::array({json{{"role", "system"}, {"content", system_content}},
                               json{{"role", "user"}, {"content", user_content}}});
  json payload{{"model", model},
              {"messages", messages},
              {"sampling", json{{"max_tokens", max_tokens}}}};
  return payload;
}

std::string producer_choices_block() {
  const json options = json::array(
      {json{{"id", "producer-cs"},
            {"label", "Content Studio package"},
            {"value", "video_producer:content_studio"},
            {"description",
             "Multi-scene video: script, TTS narration, diffusion images, ffmpeg montage."}},
       json{{"id", "producer-t2v"},
            {"label", "Direct text-to-video model"},
            {"value", "video_producer:direct_t2v"},
            {"description",
             "One neural video clip from your designated T2V model (Models → Model roles → Video)."}}});
  json payload{{"prompt", "How should I produce this video?"},
               {"allowCustom", false},
               {"options", options}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

std::string gpu_choices_block() {
  const json options = json::array(
      {json{{"id", "keep_agent"},
            {"label", "Keep agent loaded"},
            {"value", "keep_agent"},
            {"description", "Chat model stays loaded; render may be slower."}},
       json{{"id", "max_performance"},
            {"label", "Max performance"},
            {"value", "max_performance"},
            {"description", "Unload chat model during render; reload when the job finishes."}}});
  json payload{{"prompt", "Choose GPU mode for Content Studio render"},
               {"allowCustom", false},
               {"options", options}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

std::string choice_block(const std::string& prompt, const json& options) {
  json payload{{"prompt", prompt}, {"allowCustom", true}, {"options", options}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

std::set<std::string> control_ids_from_probe(const json& probe) {
  std::set<std::string> ids;
  if (!probe.is_object()) return ids;
  for (const auto& c : probe.value("controls", json::array())) {
    if (c.is_object() && c.contains("id") && c["id"].is_string()) {
      ids.insert(c["id"].get<std::string>());
    }
  }
  return ids;
}

bool briefing_show_control(const std::set<std::string>& ids, const std::string& id,
                           bool probe_active) {
  if (!probe_active) return true;
  return ids.count(id) > 0;
}

json find_probe_control(const json& probe, const std::string& id) {
  if (!probe.is_object()) return json::object();
  for (const auto& c : probe.value("controls", json::array())) {
    if (c.is_object() && c.value("id", "") == id) return c;
  }
  return json::object();
}

std::string briefing_choices_blocks(const std::map<std::string, std::string>& args,
                                    const std::set<std::string>& control_ids, bool probe_active,
                                    const json& tts_probe) {
  const std::string theme = arg_str(args, "theme", arg_str(args, "topic", "your topic"));
  const int detected_dur = arg_int(args, "max_duration_seconds", 0);
  std::ostringstream out;
  out << "Before I write the script, pick a few details for **" << theme << "** "
         "(or type your own in the composer).\n\n";
  if (detected_dur > 0) {
    out << "Detected target length: **" << detected_dur << " seconds** — confirm or change below.\n\n";
  }

  if (briefing_show_control(control_ids, "max_duration_seconds", probe_active)) {
    out << choice_block(
               "Target length",
               json::array({json{{"id", "dur-15"},
                                 {"label", "15 seconds"},
                                 {"value", "max_duration_seconds:15"}},
                            json{{"id", "dur-20"},
                                 {"label", "20 seconds"},
                                 {"value", "max_duration_seconds:20"}},
                            json{{"id", "dur-30"},
                                 {"label", "30 seconds"},
                                 {"value", "max_duration_seconds:30"}},
                            json{{"id", "dur-60"},
                                 {"label", "60 seconds (1 min)"},
                                 {"value", "max_duration_seconds:60"}},
                            json{{"id", "dur-120"},
                                 {"label", "2 minutes"},
                                 {"value", "max_duration_seconds:120"}},
                            json{{"id", "dur-180"},
                                 {"label", "3 minutes"},
                                 {"value", "max_duration_seconds:180"}}}))
        << "\n\n";
  }

  out << choice_block(
      "Narration tone",
      json::array({json{{"id", "tone-warm"},
                        {"label", "Warm & inviting"},
                        {"value", "narration_tone:warm and inviting"}},
                   json{{"id", "tone-energetic"},
                        {"label", "Energetic YouTube Short"},
                        {"value", "narration_tone:energetic and punchy"}},
                   json{{"id", "tone-doc"},
                        {"label", "Documentary / informative"},
                        {"value", "narration_tone:calm documentary"}},
                   json{{"id", "tone-playful"},
                        {"label", "Playful & fun"},
                        {"value", "narration_tone:playful and upbeat"}}}))
      << "\n\n";

  out << choice_block(
      "Video format (structure)",
      json::array({json{{"id", "fmt-short"},
                        {"label", "YouTube Short — vertical, hook VO, few scenes"},
                        {"value", "video_format:youtube_shorts_vertical"}},
                   json{{"id", "fmt-action"},
                        {"label", "Cinematic action / movie montage — many shots, sparse VO"},
                        {"value", "video_format:cinematic_action_sequence"}},
                   json{{"id", "fmt-doc"},
                        {"label", "Documentary voiceover — 16:9 narrative"},
                        {"value", "video_format:documentary_voiceover"}},
                   json{{"id", "fmt-long"},
                        {"label", "Long-form YouTube essay — 16:9"},
                        {"value", "video_format:youtube_long_16_9"}}}))
      << "\n\n";

  if (briefing_show_control(control_ids, "style_preset", probe_active)) {
    out << choice_block(
               "Visual look (image style)",
               json::array({json{{"id", "look-cinematic"},
                                 {"label", "Cinematic film (35mm, anamorphic)"},
                                 {"value", "image_style:cinematic_film"}},
                            json{{"id", "look-photo"},
                                 {"label", "Photorealistic"},
                                 {"value", "image_style:photorealistic"}},
                            json{{"id", "look-anime"},
                                 {"label", "Anime / stylized"},
                                 {"value", "image_style:anime"}},
                            json{{"id", "look-auto"},
                                 {"label", "Auto — follow scene prompts"},
                                 {"value", "image_style:auto"}}}))
        << "\n\n";
  }

  if (briefing_show_control(control_ids, "language", probe_active)) {
    out << choice_block(
               "Narration language",
               json::array({json{{"id", "lang-en"},
                                 {"label", "English"},
                                 {"value", "tts_language:en"}},
                            json{{"id", "lang-pt"},
                                 {"label", "Portuguese"},
                                 {"value", "tts_language:pt"}},
                            json{{"id", "lang-bilingual"},
                                 {"label", "Bilingual (English + Portuguese)"},
                                 {"value", "tts_language:en+pt bilingual"}}}))
        << "\n\n";
  }

  if (briefing_show_control(control_ids, "speaker", probe_active)) {
    json speaker_opts = json::array();
    const json speaker_ctrl = find_probe_control(tts_probe, "speaker");
    if (speaker_ctrl.contains("values") && speaker_ctrl["values"].is_array() &&
        !speaker_ctrl["values"].empty()) {
      for (const auto& v : speaker_ctrl["values"]) {
        if (!v.is_string()) continue;
        const std::string name = v.get<std::string>();
        speaker_opts.push_back(
            json{{"id", "spk-" + name}, {"label", name}, {"value", "tts_speaker:" + name}});
      }
    } else {
      speaker_opts = json::array({json{{"id", "spk-ryan"},
                                         {"label", "Ryan"},
                                         {"value", "tts_speaker:Ryan"}},
                                  json{{"id", "spk-vivian"},
                                       {"label", "Vivian"},
                                       {"value", "tts_speaker:Vivian"}},
                                  json{{"id", "spk-serena"},
                                       {"label", "Serena"},
                                       {"value", "tts_speaker:Serena"}}});
    }
    out << choice_block("Voice / speaker preset", speaker_opts) << "\n\n";
  }

  if (briefing_show_control(control_ids, "narration_speed", probe_active)) {
    out << choice_block(
               "Narration speed",
               json::array({json{{"id", "speed-normal"},
                                 {"label", "Normal conversational"},
                                 {"value", "narration_speed:normal"}},
                            json{{"id", "speed-fast"},
                                 {"label", "Fast / brisk (Shorts)"},
                                 {"value", "narration_speed:fast"}},
                            json{{"id", "speed-very-fast"},
                                 {"label", "Very fast / high energy"},
                                 {"value", "narration_speed:very_fast"}},
                            json{{"id", "speed-slow"},
                                 {"label", "Slightly slow / clear"},
                                 {"value", "narration_speed:slow"}},
                            json{{"id", "speed-very-slow"},
                                 {"label", "Very slow / deliberate"},
                                 {"value", "narration_speed:very_slow"}}}))
        << "\n\n";
  }

  out << choice_block(
      "Subtitles",
      json::array({json{{"id", "sub-none"},
                        {"label", "No subtitles"},
                        {"value", "include_subtitles:false"}},
                   json{{"id", "sub-en"},
                        {"label", "English subtitles"},
                        {"value", "include_subtitles:true|subtitle_language:en"}},
                   json{{"id", "sub-pt"},
                        {"label", "Portuguese subtitles"},
                        {"value", "include_subtitles:true|subtitle_language:pt"}},
                   json{{"id", "sub-match"},
                        {"label", "Match narration language"},
                        {"value", "include_subtitles:true|subtitle_language:match"}}}));

  return out.str();
}

int parse_duration_from_text(const std::string& text) {
  if (text.empty()) return 0;
  static const std::regex re_min(
      R"((?:under|less\s+than|max|up\s+to|~|about)?\s*(\d{1,3})\s*[-\s]?(?:m|min|mins|minute|minutes)\b)",
      std::regex_constants::icase);
  std::smatch m;
  if (std::regex_search(text, m, re_min) && m.size() >= 2) {
    try {
      return std::stoi(m[1].str()) * 60;
    } catch (...) {
    }
  }
  static const std::regex re_sec(
      R"((?:under|less\s+than|max|up\s+to|~|about)?\s*(\d{1,3})\s*[-\s]?(?:s|sec|secs|second|seconds)\b)",
      std::regex_constants::icase);
  if (std::regex_search(text, m, re_sec) && m.size() >= 2) {
    try {
      return std::stoi(m[1].str());
    } catch (...) {
    }
  }
  return 0;
}

std::string narration_speed_instruct(const std::string& speed) {
  if (speed == "very_slow") {
    return "Speed: very slow, deliberate — each word earns its place. Pacing must stay consistent "
           "across the whole video.";
  }
  if (speed == "slow") {
    return "Speed: slightly slower than conversational for clarity. Pacing must stay consistent "
           "across the whole video.";
  }
  if (speed == "fast") {
    return "Speed: fast, brisk — keep articulation crisp. Pacing must stay consistent across the "
           "whole video.";
  }
  if (speed == "very_fast") {
    return "Speed: very fast, high-information density — still intelligible. Pacing must stay "
           "consistent across the whole video.";
  }
  return "";
}

void apply_narration_speed_to_args(std::map<std::string, std::string>& args) {
  const std::string speed = arg_str(args, "narration_speed");
  if (speed.empty() || speed == "normal" || speed == "auto") return;
  const std::string instruct = narration_speed_instruct(speed);
  if (instruct.empty()) return;
  std::string tone = arg_str(args, "narration_tone");
  if (tone.find(instruct) != std::string::npos) return;
  if (!tone.empty()) tone += "\n\n";
  tone += instruct;
  args["narration_tone"] = tone;
}

bool theme_suggests_action_montage(const std::string& text) {
  std::string lower = text;
  for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  static const char* k_signals[] = {
      "chase", "highway", "car chase", "action scene", "action sequence", "movie style",
      "blockbuster", "transformer", "explosion", "fight scene", "montage", "multi-frame",
      "multi frame", "multi-shot", "multi shot", "cinematic action", "pursuit", "racing"};
  for (const char* sig : k_signals) {
    if (lower.find(sig) != std::string::npos) return true;
  }
  return false;
}

void infer_from_user_request(const std::string& user_message,
                             std::map<std::string, std::string>& args) {
  if (arg_str(args, "max_duration_seconds").empty()) {
    const int d = parse_duration_from_text(user_message);
    if (d > 0) args["max_duration_seconds"] = std::to_string(d);
  }
  std::string lower = user_message;
  for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (arg_str(args, "video_format").empty() && arg_str(args, "video_type").empty()) {
    if (theme_suggests_action_montage(user_message)) {
      args["video_format"] = "cinematic_action_sequence";
    } else if (lower.find("youtube short") != std::string::npos || lower.find("shorts") != std::string::npos) {
      args["video_format"] = "youtube_shorts_vertical";
    }
  }
  if (arg_str(args, "image_style").empty() &&
      (lower.find("youtube short") != std::string::npos || lower.find("shorts") != std::string::npos)) {
    args["image_style"] = "digital_art";
  }
  if (arg_str(args, "pipeline_mode").empty()) {
    args["pipeline_mode"] = "local_media";
  }
}

void merge_briefing_token(const std::string& token, std::map<std::string, std::string>& args) {
  std::string line = token;
  while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) line.erase(line.begin());
  while (!line.empty() && (line.back() == ' ' || line.back() == '\r')) line.pop_back();
  if (line.empty()) return;

  if (line.find("Use defaults") != std::string::npos ||
      line.find("you decide") != std::string::npos) {
    args["briefing_defaults"] = "true";
    return;
  }

  const auto apply_kv = [&](const std::string& key, const std::string& val) {
    if (key == "narration_tone" || key == "tone") {
      if (!val.empty()) args["narration_tone"] = val;
    } else if (key == "video_format" || key == "format" || key == "video_type") {
      if (!val.empty()) args["video_format"] = val;
    } else if (key == "image_style" || key == "style" || key == "visual_style" || key == "visual_look") {
      if (!val.empty()) args["image_style"] = val;
    } else if (key == "tts_language" || key == "language" || key == "narration_language") {
      if (!val.empty()) args["tts_language"] = val;
    } else if (key == "subtitle_language" || key == "subtitles") {
      if (!val.empty()) args["subtitle_language"] = val;
    } else if (key == "include_subtitles") {
      args["include_subtitles"] = (val == "true" || val == "1" || val == "yes") ? "true" : "false";
    } else if (key == "pipeline_mode") {
      if (!val.empty()) args["pipeline_mode"] = val;
    } else if (key == "max_duration_seconds") {
      if (!val.empty()) args["max_duration_seconds"] = val;
    } else if (key == "narration_speed" || key == "speech_speed" || key == "tts_speed") {
      if (!val.empty()) args["narration_speed"] = val;
    } else if (key == "tts_speaker" || key == "speaker") {
      if (!val.empty()) args["tts_speaker"] = val;
    } else if (key == "video_producer" || key == "producer") {
      if (!val.empty()) args["video_producer"] = val;
    }
  };

  const auto pipe = line.find('|');
  if (pipe != std::string::npos) {
    merge_briefing_token(line.substr(0, pipe), args);
    merge_briefing_token(line.substr(pipe + 1), args);
    return;
  }

  const auto colon = line.find(':');
  if (colon != std::string::npos && colon < 48) {
    std::string key = line.substr(0, colon);
    std::string val = line.substr(colon + 1);
    while (!key.empty() && key.back() == ' ') key.pop_back();
    while (!val.empty() && val.front() == ' ') val.erase(val.begin());
    for (char& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    apply_kv(key, val);
    return;
  }

  static const std::array<const char*, 5> k_order = {"video_format", "narration_tone", "image_style",
                                                     "tts_language", "include_subtitles"};
  for (const char* field : k_order) {
    if (arg_str(args, field).empty()) {
      args[field] = line;
      return;
    }
  }
}

void merge_briefing_from_message(const std::string& user_message,
                                 std::map<std::string, std::string>& args) {
  auto split_inline_tokens = [](const std::string& line, std::vector<std::string>& out) {
    static const std::regex key_re(
        R"(\b(narration_tone|video_format|video_type|image_style|tts_language|subtitle_language|include_subtitles|pipeline_mode|max_duration_seconds|narration_speed|speech_speed|tts_speed|tts_speaker|speaker)\s*:)",
        std::regex_constants::icase);
    std::vector<size_t> starts;
    for (std::sregex_iterator it(line.begin(), line.end(), key_re), end; it != end; ++it) {
      starts.push_back(static_cast<size_t>(it->position()));
    }
    if (starts.empty()) {
      if (!line.empty()) out.push_back(line);
      return;
    }
    for (size_t i = 0; i < starts.size(); ++i) {
      const size_t begin = starts[i];
      const size_t end = (i + 1 < starts.size()) ? starts[i + 1] : line.size();
      std::string piece = line.substr(begin, end - begin);
      while (!piece.empty() && (piece.back() == ' ' || piece.back() == '\r')) piece.pop_back();
      if (!piece.empty()) out.push_back(piece);
    }
  };

  std::istringstream lines(user_message);
  std::string line;
  while (std::getline(lines, line)) {
    std::vector<std::string> tokens;
    split_inline_tokens(line, tokens);
    for (const auto& token : tokens) merge_briefing_token(token, args);
  }
  if (arg_str(args, "include_subtitles") == "true" &&
      arg_str(args, "subtitle_language") == "match" && !arg_str(args, "tts_language").empty()) {
    args["subtitle_language"] = arg_str(args, "tts_language");
  }
  apply_narration_speed_to_args(args);
}

json run_args_to_json(const std::map<std::string, std::string>& args) {
  json out = json::object();
  for (const auto& [k, v] : args) out[k] = v;
  return out;
}

std::map<std::string, std::string> json_to_run_args(const json& j) {
  std::map<std::string, std::string> out;
  if (!j.is_object()) return out;
  for (auto it = j.begin(); it != j.end(); ++it) {
    if (it.value().is_string()) out[it.key()] = it.value().get<std::string>();
  }
  return out;
}

std::string format_run_started_message(const json& run, const std::string& title) {
  const std::string job_id = run.value("job_id", run.value("jobId", ""));
  const std::string status = run.value("status", "queued");
  std::ostringstream msg;
  msg << "Content Studio render started";
  if (!title.empty()) msg << " for **" << title << "**";
  msg << ".\n\n";
  msg << "The job is **" << status << "**";
  if (!job_id.empty()) msg << " (id `" << job_id << "`)";
  msg << ". Track progress on the **Content Studio** card below — use **Play in chat** when it finishes.";
  return msg.str();
}

json direct_video_card_part(const std::string& job_id, const std::string& title,
                            const std::string& status, int64_t started_at_ms = 0) {
  json card{{"type", "direct_video"},
            {"jobId", job_id},
            {"status", status},
            {"title", title.empty() ? "Text-to-video" : title}};
  if (started_at_ms > 0) card["startedAt"] = started_at_ms;
  return card;
}

json content_studio_card_part(const json& run, const std::string& title, int64_t started_at_ms = 0) {
  json card{{"type", "content_studio"},
            {"jobId", run.value("job_id", run.value("jobId", ""))},
            {"projectId", run.value("project_id", run.value("projectId", ""))},
            {"status", run.value("status", "queued")},
            {"title", title.empty() ? "Content Studio" : title}};
  if (started_at_ms > 0) card["startedAt"] = started_at_ms;
  return card;
}

bool is_direct_t2v_producer(const std::map<std::string, std::string>& args) {
  return arg_str(args, "video_producer") == "direct_t2v";
}

bool is_t2v_script(const json& script) {
  return script.is_object() && script.contains("prompt") && script["prompt"].is_string() &&
         !script.contains("scenes");
}

json script_prompt_request_from_args(const std::map<std::string, std::string>& args) {
  const std::string theme = arg_str(args, "theme", arg_str(args, "topic"));
  json req{{"theme", theme},
            {"title", arg_str(args, "title", theme.substr(0, 80))},
            {"episode_topic", arg_str(args, "episode_topic")},
            {"narration_tone", arg_str(args, "narration_tone")},
            {"voice_gender", arg_str(args, "voice_gender")},
            {"tts_language", arg_str(args, "tts_language")},
            {"tts_speaker", arg_str(args, "tts_speaker")},
            {"image_style", arg_str(args, "image_style")},
            {"content_notes", arg_str(args, "content_notes")},
            {"subtitle_language", arg_str(args, "subtitle_language")}};
  const std::string vf = arg_str(args, "video_format", arg_str(args, "video_type"));
  if (!vf.empty()) req["video_format"] = vf;
  int dur = arg_int(args, "max_duration_seconds", 0);
  if (dur <= 0) {
    const std::string user = arg_str(args, "user_message", arg_str(args, "message"));
    dur = parse_duration_from_text(user.empty() ? theme : user);
  }
  if (dur > 0) req["max_duration_seconds"] = dur;
  if (arg_bool(args, "include_subtitles")) req["include_subtitles"] = true;
  if (arg_bool(args, "no_image_mode")) req["no_image_mode"] = true;
  const std::string speed = arg_str(args, "narration_speed");
  if (!speed.empty() && speed != "normal" && speed != "auto") {
    req["tts_voice_style"] = json{{"speed", speed}};
  }
  return req;
}

bool looks_like_briefing_reply(const std::string& user_message) {
  if (user_message.empty()) return false;
  static const std::regex kv(
      R"((narration_tone|video_format|video_type|image_style|tts_language|subtitle_language|include_subtitles|pipeline_mode|max_duration_seconds|narration_speed|speech_speed|tts_speed|tts_speaker|speaker)\s*:)",
      std::regex_constants::icase);
  if (std::regex_search(user_message, kv)) return true;
  if (user_message.find("Use defaults") != std::string::npos) return true;
  return false;
}

std::string parse_gpu_mode(const std::map<std::string, std::string>& args) {
  std::string mode = arg_str(args, "agent_gpu_mode");
  if (!mode.empty()) return mode;
  const std::string user = arg_str(args, "user_message", arg_str(args, "message"));
  if (user.empty()) return "";
  static const std::regex re(R"((?:GPU\s*mode|gpu\s*mode)\s*:\s*(keep_agent|max_performance))",
                             std::regex_constants::icase);
  std::smatch m;
  if (std::regex_search(user, m, re) && m.size() >= 2) {
    std::string v = m[1].str();
    for (char& c : v) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return v;
  }
  const std::string lower = [&user]() {
    std::string s = user;
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
  }();
  if (lower.find("max performance") != std::string::npos ||
      lower.find("max_performance") != std::string::npos ||
      lower == "max_performance") {
    return "max_performance";
  }
  if (lower.find("keep agent") != std::string::npos || lower.find("keep_agent") != std::string::npos ||
      lower == "keep_agent") {
    return "keep_agent";
  }
  return "";
}

std::string last_user_message_for_session(SessionStore* sessions, const std::string& session_id) {
  if (!sessions || session_id.empty()) return "";
  try {
    const json msgs = sessions->get_messages(session_id);
    if (!msgs.is_array()) return "";
    for (int i = static_cast<int>(msgs.size()) - 1; i >= 0; --i) {
      if (msgs[static_cast<size_t>(i)].value("role", "") == "user") {
        return msgs[static_cast<size_t>(i)].value("content", "");
      }
    }
  } catch (...) {
  }
  return "";
}

std::map<std::string, std::string> args_with_session_user_message(
    const std::map<std::string, std::string>& args, SessionStore* sessions) {
  std::map<std::string, std::string> out = args;
  const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
  if (!arg_str(args, "user_message").empty() || !arg_str(args, "message").empty()) return out;
  const std::string from_session = last_user_message_for_session(sessions, session_id);
  if (!from_session.empty()) out["user_message"] = from_session;
  return out;
}

}  // namespace

std::string ContentStudioOrchestrator::build_briefing_choices(
    const std::map<std::string, std::string>& args) const {
  std::set<std::string> control_ids;
  json tts_probe = json::object();
  bool probe_active = false;

  if (!content_studio_ || !settings_) {
    return briefing_choices_blocks(args, control_ids, false, tts_probe);
  }

  try {
    content_studio_->ensure_started();
    const json catalog = settings_->local_generation_catalog();
    const std::string default_tts = catalog["defaults"].value("tts", "");
    const std::string default_image = catalog["defaults"].value("image", "");

    std::string tts_repo;
    std::string image_repo;
    const json gen = settings_->load_generation();
    if (gen.contains("ttsRepoId") && gen["ttsRepoId"].is_string()) {
      tts_repo = gen["ttsRepoId"].get<std::string>();
    }
    if (gen.contains("imageRepoId") && gen["imageRepoId"].is_string()) {
      image_repo = gen["imageRepoId"].get<std::string>();
    }
    if (config_) {
      const json tools = config_->load().value("omegaTools", json::object());
      if (tts_repo.empty() && tools.contains("contentStudioTtsRepoId") &&
          tools["contentStudioTtsRepoId"].is_string()) {
        tts_repo = tools["contentStudioTtsRepoId"].get<std::string>();
      }
      if (image_repo.empty() && tools.contains("contentStudioImageRepoId") &&
          tools["contentStudioImageRepoId"].is_string()) {
        image_repo = tools["contentStudioImageRepoId"].get<std::string>();
      }
    }
    if (tts_repo.empty()) tts_repo = default_tts;
    if (image_repo.empty()) image_repo = default_image;

    if (!tts_repo.empty()) {
      tts_probe = content_studio_->invoke_cli(
          "probe-capabilities", json{{"modality", "tts"}, {"repo_id", tts_repo}});
      const auto ids = control_ids_from_probe(tts_probe);
      control_ids.insert(ids.begin(), ids.end());
      probe_active = true;
    }
    if (!image_repo.empty()) {
      const json image_probe = content_studio_->invoke_cli(
          "probe-capabilities", json{{"modality", "image"}, {"repo_id", image_repo}});
      const auto ids = control_ids_from_probe(image_probe);
      control_ids.insert(ids.begin(), ids.end());
      probe_active = true;
    }
  } catch (...) {
    probe_active = false;
    control_ids.clear();
    tts_probe = json::object();
  }

  return briefing_choices_blocks(args, control_ids, probe_active, tts_probe);
}

void ContentStudioOrchestrator::attach(ContentStudioSupervisor* content_studio,
                                       ContentJobDeliveryService* delivery,
                                       ContentStudioSettings* settings, ConfigStore* config,
                                       EngineClient* engine, SessionStore* sessions,
                                       ProjectStore* projects, EventBus* events,
                                       PipelineActivityService* pipeline) {
  content_studio_ = content_studio;
  delivery_ = delivery;
  settings_ = settings;
  config_ = config;
  engine_ = engine;
  sessions_ = sessions;
  projects_ = projects;
  events_ = events;
  pipeline_ = pipeline;
}

void ContentStudioOrchestrator::set_pending(const std::string& session_id, PendingRun pending) {
  if (session_id.empty()) return;
  const PendingRun snapshot = pending;
  {
    std::lock_guard lock(pending_mu_);
    pending_by_session_[session_id] = std::move(pending);
  }
  try {
    const fs::path path = content_pending_path(session_id);
    fs::create_directories(path.parent_path());
    json disk{{"phase", snapshot.phase},
              {"run_args", snapshot.run_args},
              {"script", snapshot.script}};
    std::ofstream out(path);
    out << disk.dump();
  } catch (...) {
  }
}

std::optional<ContentStudioOrchestrator::PendingRun>
ContentStudioOrchestrator::get_pending(const std::string& session_id) const {
  if (session_id.empty()) return std::nullopt;
  {
    std::lock_guard lock(pending_mu_);
    const auto it = pending_by_session_.find(session_id);
    if (it != pending_by_session_.end()) return it->second;
  }
  try {
    const fs::path path = content_pending_path(session_id);
    if (!fs::exists(path)) return std::nullopt;
    const json disk = json::parse(std::ifstream(path));
    PendingRun pending;
    pending.phase = disk.value("phase", "");
    pending.run_args = disk.value("run_args", json::object());
    pending.script = disk.value("script", json::object());
    if (pending.phase.empty()) return std::nullopt;
    std::lock_guard lock(pending_mu_);
    pending_by_session_[session_id] = pending;
    return pending;
  } catch (...) {
    return std::nullopt;
  }
}

void ContentStudioOrchestrator::clear_pending(const std::string& session_id) {
  if (session_id.empty()) return;
  {
    std::lock_guard lock(pending_mu_);
    pending_by_session_.erase(session_id);
  }
  try {
    fs::remove(content_pending_path(session_id));
  } catch (...) {
  }
}

void ContentStudioOrchestrator::discard_session(const std::string& session_id) {
  clear_pending(session_id);
}

std::string ContentStudioOrchestrator::webhook_url() const {
  if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT"); rt && *rt) {
    return "http://127.0.0.1:" + std::string(rt) + "/v1/content-studio/webhook";
  }
  const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
  if (fs::exists(rt_state)) {
    try {
      std::ifstream in(rt_state);
      const json st = json::parse(in);
      if (st.contains("port")) {
        return "http://127.0.0.1:" + std::to_string(st["port"].get<int>()) +
               "/v1/content-studio/webhook";
      }
    } catch (...) {
    }
  }
  if (const char* shell = std::getenv("OMEGA_SHELL_URL"); shell && *shell) {
    return std::string(shell) + "/v1/content-studio/webhook";
  }
  return "http://127.0.0.1:9877/v1/content-studio/webhook";
}

std::string ContentStudioOrchestrator::resolve_model_id() const {
  if (settings_) {
    const std::string from_gen = settings_->load_generation().value("omegaModelId", "");
    if (!from_gen.empty()) return from_gen;
  }
  if (config_) return config_->load().value("defaultModel", "");
  return {};
}

void ContentStudioOrchestrator::sync_settings_to_api() const {
  if (!content_studio_ || !settings_) return;
  content_studio_->sync_settings_to_api();
}

std::optional<json> ContentStudioOrchestrator::parse_script_json(const std::string& text) const {
  if (text.empty()) return std::nullopt;
  return extract_script_json_object(text);
}

std::optional<json> ContentStudioOrchestrator::parse_t2v_prompt_json(const std::string& text) const {
  if (text.empty()) return std::nullopt;

  std::string candidate = text;
  if (const auto fence = text.find("```"); fence != std::string::npos) {
    const auto start = text.find('\n', fence);
    const auto end = text.find("```", start == std::string::npos ? fence + 3 : start + 1);
    if (start != std::string::npos && end != std::string::npos && end > start) {
      candidate = text.substr(start + 1, end - start - 1);
    }
  }

  const auto first = candidate.find('{');
  const auto last = candidate.rfind('}');
  if (first == std::string::npos || last == std::string::npos || last <= first) {
    return std::nullopt;
  }
  candidate = candidate.substr(first, last - first + 1);

  try {
    json parsed = json::parse(candidate);
    auto ok = [](const json& obj) {
      return obj.is_object() && obj.contains("prompt") && obj["prompt"].is_string() &&
             !obj["prompt"].get<std::string>().empty();
    };
    if (ok(parsed)) return parsed;
    for (const char* key : {"result", "output", "script", "data", "response"}) {
      if (parsed.contains(key) && ok(parsed[key])) return parsed[key].get<json>();
    }
  } catch (...) {
  }
  return std::nullopt;
}

json ContentStudioOrchestrator::generate_script(const std::map<std::string, std::string>& args_in) {
  if (!engine_) {
    return tool_result_json(ToolResult{false, "Chat engine unavailable for script generation", json::array()});
  }

  std::map<std::string, std::string> args = args_in;
  apply_narration_speed_to_args(args);
  if (arg_int(args, "max_duration_seconds", 0) <= 0) {
    const std::string user = arg_str(args, "user_message", arg_str(args, "message"));
    const int inferred = parse_duration_from_text(user.empty() ? arg_str(args, "theme", arg_str(args, "topic")) : user);
    if (inferred > 0) args["max_duration_seconds"] = std::to_string(inferred);
  }

  const std::string theme = arg_str(args, "theme", arg_str(args, "topic"));
  const std::string title = arg_str(args, "title", theme.substr(0, 80));
  const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));

  json brief_meta = json::object();
  std::string system_prompt = kScriptSystemPrompt;
  std::string user_prompt;
  {
    std::ostringstream fallback;
    fallback << "Write a video script JSON for Content Studio.\n";
    fallback << "Theme/topic: " << (theme.empty() ? title : theme) << '\n';
    if (!title.empty()) fallback << "Working title: " << title << '\n';
    if (arg_int(args, "max_duration_seconds", 0) > 0) {
      fallback << "Target total duration seconds: " << arg_int(args, "max_duration_seconds", 0) << '\n';
    }
    if (!arg_str(args, "narration_tone").empty()) {
      fallback << "Narration tone: " << arg_str(args, "narration_tone") << '\n';
    }
    user_prompt = fallback.str();
  }

  if (content_studio_) {
    try {
      content_studio_->ensure_started();
      const json prompt_data =
          content_studio_->invoke_cli("build-script-prompt", script_prompt_request_from_args(args));
      if (prompt_data.is_object()) {
        if (prompt_data.contains("system_prompt") && prompt_data["system_prompt"].is_string()) {
          system_prompt = prompt_data["system_prompt"].get<std::string>();
        }
        if (prompt_data.contains("user_prompt") && prompt_data["user_prompt"].is_string()) {
          user_prompt = prompt_data["user_prompt"].get<std::string>();
        }
        if (prompt_data.contains("brief") && prompt_data["brief"].is_object()) {
          brief_meta = prompt_data["brief"];
        }
        if (prompt_data.contains("image_style") && prompt_data["image_style"].is_string()) {
          brief_meta["resolved_image_style"] = prompt_data["image_style"];
        }
      }
    } catch (const std::exception& e) {
      cs_log(std::string("build-script-prompt fallback: ") + e.what(), "warn");
    }
  }

  const std::string model = resolve_model_id();
  if (model.empty()) {
    return tool_result_json(
        ToolResult{false, "No chat model configured for script generation (set defaultModel)", json::array()});
  }

  try {
    engine_->ensure_started();
  } catch (const std::exception& e) {
    return tool_result_json(ToolResult{false, e.what(), json::array()});
  }

  const auto gate = check_chat_gate(*engine_, model);
  if (!gate.ok) {
    return tool_result_json(ToolResult{false, gate.message, json::array()});
  }

  json payload = fit_content_studio_chat_payload(config_, engine_, model, std::move(system_prompt),
                                                 std::move(user_prompt), 2048);
  if (config_ && engine_) {
    cs_log("script generation context",
           "info",
           json{{"model", model},
                {"configured_context", resolve_context_size(*config_, model)},
                {"loaded_context", query_loaded_context_size(*engine_, model)},
                {"effective_context",
                 resolve_effective_context_size(*config_, *engine_, model)},
                {"max_tokens", payload["sampling"].value("max_tokens", 0)}});
  }
  if (config_) apply_structured_generation_options(*config_, model, payload);

  std::string text;
  std::optional<json> script;
  constexpr const char* kRepairHint =
      "\n\n---\nYour previous reply was not valid script JSON. Return ONE JSON object only "
      "(no markdown fences, no thinking, no prose). Must include a non-empty \"scenes\" array.";
  for (int attempt = 0; attempt < 2; ++attempt) {
    try {
      const json data = engine_->chat_send(payload, "cs-script-" + random_uuid(), nullptr, {}, 600000);
      text = data.value("text", text);
    } catch (const std::exception& e) {
      return tool_result_json(ToolResult{false, std::string("Script generation failed: ") + e.what(), json::array()});
    }
    script = parse_script_json(text);
    if (script) break;
    if (attempt == 0 && payload.contains("messages") && payload["messages"].is_array() &&
        payload["messages"].size() >= 2 && payload["messages"][1].contains("content") &&
        payload["messages"][1]["content"].is_string()) {
      std::string user = payload["messages"][1]["content"].get<std::string>();
      user += kRepairHint;
      payload["messages"][1]["content"] = user;
      cs_log("script JSON parse retry", "warn",
             json{{"model", model}, {"preview", preview_text(text)}});
    }
  }
  if (!script) {
    cs_log("script JSON parse failed", "error",
           json{{"model", model}, {"preview", preview_text(text)}, {"bytes", text.size()}});
    return tool_result_json(
        ToolResult{false,
                   "Model did not return valid script JSON. Response preview: " + preview_text(text),
                   json::array()});
  }

  if (content_studio_ && brief_meta.is_object() && !brief_meta.empty()) {
    try {
      json validate_req{{"script", *script}, {"brief", brief_meta}};
      if (brief_meta.contains("resolved_image_style") &&
          brief_meta["resolved_image_style"].is_string()) {
        validate_req["image_style"] = brief_meta["resolved_image_style"];
      }
      const json validated =
          content_studio_->invoke_cli("validate-agent-script", validate_req);
      if (validated.is_object() && validated.contains("script") && validated["script"].is_object()) {
        script = validated["script"].get<json>();
      }
    } catch (const std::exception& e) {
      return tool_result_json(
          ToolResult{false, std::string("Script validation failed: ") + e.what(), json::array()});
    }
  }

  PendingRun pending;
  pending.run_args = run_args_to_json(args);
  if (brief_meta.is_object() && !brief_meta.empty()) {
    pending.run_args["script_brief"] = brief_meta;
    if (brief_meta.contains("video_type") && brief_meta["video_type"].is_string()) {
      pending.run_args["video_type"] = brief_meta["video_type"].get<std::string>();
    }
    if (brief_meta.contains("resolved_image_style") &&
        brief_meta["resolved_image_style"].is_string()) {
      pending.run_args["image_style"] = brief_meta["resolved_image_style"].get<std::string>();
    }
  }
  pending.script = *script;
  pending.phase = "awaiting_gpu";
  set_pending(session_id, std::move(pending));

  if (pipeline_) {
    pipeline_->set(json{{"subsystem", "content_studio"},
                         {"label", "Content Studio"},
                         {"stage", "Script ready"},
                         {"updatedAt", now_ms()}});
  }

  const std::string script_title = script->value("title", title);
  const size_t scene_count =
      script->contains("scenes") && (*script)["scenes"].is_array() ? (*script)["scenes"].size() : 0;
  cs_log("script ready session=" + session_id, "info",
         json{{"session_id", session_id},
              {"scenes", scene_count},
              {"title", script_title},
              {"video_type", brief_meta.value("video_type", "")}});
  std::ostringstream summary;
  summary << "Script ready";
  if (!script_title.empty()) summary << " — **" << script_title << "**";
  if (scene_count > 0) summary << " (" << scene_count << " scene" << (scene_count == 1 ? "" : "s") << ")";
  if (brief_meta.is_object() && brief_meta.contains("video_type")) {
    summary << " · format: `" << brief_meta["video_type"].get<std::string>() << "`";
  }
  if (arg_int(args, "max_duration_seconds", 0) > 0) {
    summary << " · target: **" << arg_int(args, "max_duration_seconds", 0) << "s**";
  }
  summary << ".\n\nPick GPU mode to start the render.\n\n" << gpu_choices_block();

  return tool_result_json(ToolResult{true, summary.str(), json::array()});
}

json ContentStudioOrchestrator::build_run_body(const std::map<std::string, std::string>& args,
                                               const json& script) const {
  const std::string theme = arg_str(args, "theme", arg_str(args, "topic"));
  const std::string title = arg_str(args, "title", script.value("title", theme.substr(0, 80)));
  const std::string mode = arg_str(args, "pipeline_mode", "local_media");

  json body{{"title", title.empty() ? "Content Studio run" : title},
            {"theme", theme},
            {"pipeline_mode", mode},
            {"wait_seconds", arg_int(args, "wait_seconds", 0)},
            {"webhook_url", webhook_url()},
            {"include_subtitles", arg_bool(args, "include_subtitles")},
            {"script_use_web_research", arg_bool(args, "script_use_web_research", true)}};

  put_if(body, "project_id", args, "project_id");
  put_if(body, "episode_topic", args, "episode_topic");
  put_int_if(body, "max_duration_seconds", args, "max_duration_seconds");
  put_if(body, "narration_tone", args, "narration_tone");
  put_if(body, "voice_gender", args, "voice_gender");
  put_if(body, "tts_language", args, "tts_language");
  put_if(body, "tts_speaker", args, "tts_speaker");
  put_if(body, "image_style", args, "image_style");
  put_if(body, "video_format", args, "video_format");
  put_if(body, "video_type", args, "video_type");
  put_if(body, "subtitle_language", args, "subtitle_language");
  put_if(body, "content_notes", args, "content_notes");
  put_if(body, "reuse_images_from_job_id", args, "reuse_images_from_job_id");

  const std::string speed = arg_str(args, "narration_speed");
  if (!speed.empty() && speed != "normal" && speed != "auto") {
    body["tts_voice_style"] = json{{"speed", speed}};
  }
  if (arg_int(args, "max_duration_seconds", 0) > 0) body["duration_user_confirmed"] = true;

  if (arg_bool(args, "duration_user_confirmed")) body["duration_user_confirmed"] = true;
  if (arg_bool(args, "no_image_mode")) body["no_image_mode"] = true;

  const std::string pipeline_mode = body.value("pipeline_mode", "");
  if (pipeline_mode == "local_media" || pipeline_mode == "full_publish") {
    bool prefer_native = false;
    if (settings_) prefer_native = settings_->load_generation().value("preferNativeMedia", false);
    body["use_native_media"] = prefer_native;
  }

  if (settings_) {
    const json gen = settings_->load_generation();
    std::string image_pin =
        gen.contains("imageRepoId") && gen["imageRepoId"].is_string()
            ? gen["imageRepoId"].get<std::string>()
            : "";
    std::string tts_pin = gen.contains("ttsRepoId") && gen["ttsRepoId"].is_string()
                              ? gen["ttsRepoId"].get<std::string>()
                              : "";
    if (config_) {
      const json tools = config_->load().value("omegaTools", json::object());
      if (image_pin.empty() && tools.contains("contentStudioImageRepoId") &&
          tools["contentStudioImageRepoId"].is_string()) {
        image_pin = tools["contentStudioImageRepoId"].get<std::string>();
      }
      if (tts_pin.empty() && tools.contains("contentStudioTtsRepoId") &&
          tools["contentStudioTtsRepoId"].is_string()) {
        tts_pin = tools["contentStudioTtsRepoId"].get<std::string>();
      }
    }
    if (!image_pin.empty()) body["hf_image_repo_id"] = image_pin;
    if (!tts_pin.empty()) body["hf_tts_repo_id"] = tts_pin;
  }

  std::string script_mode = "content_studio";
  if (settings_) {
    script_mode = settings_->load_generation().value("scriptMode", "agent_orchestrated");
  }
  if (script.is_object() && !script.empty()) {
    body["script_mode"] = "agent_orchestrated";
    body["script_content"] = script;
  } else {
    body["script_mode"] = script_mode;
  }

  return body;
}

json ContentStudioOrchestrator::handle_llm_chat_video_request(
    const std::map<std::string, std::string>& merged_in, const std::string& session_id) {
  std::map<std::string, std::string> merged = merged_in;
  if (delivery_) delivery_->cancel_active_jobs_for_session(session_id);
  clear_pending(session_id);

  const std::string user_text = arg_str(merged, "user_message", arg_str(merged, "message"));
  const std::string theme = arg_str(merged, "theme", arg_str(merged, "topic", user_text));
  if (!theme.empty() && merged["theme"].empty()) merged["theme"] = theme;
  infer_from_user_request(user_text.empty() ? theme : user_text, merged);

  const bool t2v_ready = config_ && MediaExecutor::video_model_ready(config_->load());

  PendingRun next;
  next.run_args = run_args_to_json(merged);
  if (t2v_ready) {
    next.phase = "producer_choice";
    set_pending(session_id, std::move(next));
    cs_log("producer choice session=" + session_id, "info",
           json{{"theme", theme.substr(0, 120)}, {"session_id", session_id}});
    std::ostringstream intro;
    intro << "I can produce **" << (theme.empty() ? "your video" : theme)
          << "** in two ways — pick one:\n\n";
    intro << producer_choices_block();
    return tool_result_json(ToolResult{true, intro.str(), json::array()});
  }

  next.phase = "briefing";
  set_pending(session_id, std::move(next));
  cs_log("briefing started session=" + session_id, "info",
         json{{"theme", theme.substr(0, 120)}, {"session_id", session_id}});
  return tool_result_json(ToolResult{true, build_briefing_choices(merged), json::array()});
}

json ContentStudioOrchestrator::generate_t2v_prompt(const std::map<std::string, std::string>& args) {
  if (!engine_) {
    return tool_result_json(
        ToolResult{false, "Chat engine unavailable for video prompt generation", json::array()});
  }

  const std::string theme = arg_str(args, "theme", arg_str(args, "topic"));
  const std::string title = arg_str(args, "title", theme.substr(0, 80));
  const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));

  std::ostringstream user_prompt;
  user_prompt << "Write a text-to-video prompt JSON for this clip.\n";
  user_prompt << "Theme/topic: " << (theme.empty() ? title : theme) << '\n';
  if (!title.empty()) user_prompt << "Working title: " << title << '\n';
  if (arg_int(args, "max_duration_seconds", 0) > 0) {
    user_prompt << "Target clip duration seconds: " << arg_int(args, "max_duration_seconds", 0) << '\n';
  }

  const std::string model = resolve_model_id();
  if (model.empty()) {
    return tool_result_json(
        ToolResult{false, "No chat model configured (set defaultModel)", json::array()});
  }

  try {
    engine_->ensure_started();
  } catch (const std::exception& e) {
    return tool_result_json(ToolResult{false, e.what(), json::array()});
  }

  json payload = fit_content_studio_chat_payload(config_, engine_, model, kT2vSystemPrompt,
                                                 user_prompt.str(), 768);
  if (config_) apply_structured_generation_options(*config_, model, payload);

  std::string text;
  try {
    const json data = engine_->chat_send(payload, "cs-t2v-" + random_uuid(), nullptr, {}, 300000);
    text = data.value("text", text);
  } catch (const std::exception& e) {
    return tool_result_json(
        ToolResult{false, std::string("Video prompt generation failed: ") + e.what(), json::array()});
  }

  auto script = parse_t2v_prompt_json(text);
  if (!script) {
    return tool_result_json(
        ToolResult{false, "Model did not return valid T2V prompt JSON", json::array()});
  }

  PendingRun pending;
  pending.run_args = run_args_to_json(args);
  pending.run_args["video_producer"] = "direct_t2v";
  pending.script = *script;
  pending.phase = "awaiting_gpu";
  set_pending(session_id, std::move(pending));

  if (pipeline_) {
    pipeline_->set(json{{"subsystem", "direct_t2v"},
                        {"label", "Text-to-video"},
                        {"stage", "Prompt ready"},
                        {"updatedAt", now_ms()}});
  }

  const std::string script_title = script->value("title", title);
  std::ostringstream summary;
  summary << "Video prompt ready";
  if (!script_title.empty()) summary << " — **" << script_title << "**";
  summary << ".\n\nPick GPU mode to generate the clip (chat model unloads during render if you "
             "choose Max performance).\n\n"
          << gpu_choices_block();

  return tool_result_json(ToolResult{true, summary.str(), json::array()});
}

json ContentStudioOrchestrator::submit_direct_t2v(std::map<std::string, std::string> merged,
                                                 const std::string& session_id,
                                                 const json& script, const std::string& gpu_mode) {
  if (session_id.empty()) {
    return tool_result_json(
        ToolResult{false, "Save this chat session before generating video.", json::array()});
  }
  if (!is_t2v_script(script)) {
    return tool_result_json(
        ToolResult{false, "Video prompt is not ready — complete producer choices first.",
                   json::array()});
  }
  if (gpu_mode.empty()) {
    return tool_result_json(
        ToolResult{false, "Pick GPU mode (Keep agent loaded or Max performance) before render.",
                   json::array()});
  }
  if (!projects_ || !config_ || !delivery_ || !events_) {
    return tool_result_json(ToolResult{false, "Direct video render unavailable", json::array()});
  }

  const std::string theme = arg_str(merged, "theme", arg_str(merged, "topic"));
  const std::string title = script.value("title", arg_str(merged, "title", theme.substr(0, 80)));
  const std::string prompt = script.value("prompt", "");
  const std::string negative = script.value("negative_prompt", "");
  const int max_duration = arg_int(merged, "max_duration_seconds", 0);

  if (delivery_) delivery_->cancel_active_jobs_for_session(session_id);

  std::string chat_model = arg_str(merged, "model_id");
  if (chat_model.empty()) chat_model = resolve_model_id();
  if (delivery_) {
    if (gpu_mode == "max_performance") {
      delivery_->prepare_max_performance_job(session_id, chat_model, title, theme);
    } else {
      delivery_->remember_reload_after_job(session_id, chat_model, title, theme);
    }
  }

  const int64_t started_at = now_ms();
  const std::string job_id = "t2v-" + random_uuid();
  projects_->ensure_dir(session_id);
  const fs::path media_dir = fs::path(projects_->open_folder(session_id)) / "media";
  fs::create_directories(media_dir);
  const std::string filename = job_id.substr(4, 12) + ".mp4";
  const fs::path out_mp4 = media_dir / filename;

  clear_pending(session_id);
  delivery_->track_direct_video_job(job_id, session_id);

  const json cfg = config_->load();
  ContentJobDeliveryService* delivery = delivery_;
  EventBus* events = events_;
  DebugStore* debug = debug_;

  std::thread([cfg, prompt, negative, out_mp4, session_id, job_id, title, started_at, max_duration,
               delivery, events, debug]() {
    emit_debug(debug, "orchestrator", "direct t2v render start job=" + job_id, "info",
               json{{"session_id", session_id}, {"out", out_mp4.string()},
                    {"max_duration_seconds", max_duration}});
    const VideoGenerateResult gen = MediaExecutor::generate_video(
        cfg, prompt, out_mp4.string(), negative, false, max_duration);
    if (!gen.ok) {
      emit_debug(debug, "orchestrator", "direct t2v render failed job=" + job_id, "error",
                 json{{"session_id", session_id}, {"error", gen.error}});
    }
    json video_part = json::object();
    if (gen.ok) {
      video_part = json{{"type", "video"},
                        {"ref", out_mp4.filename().string()},
                        {"alt", title.substr(0, 120)}};
    }
    if (delivery && events) {
      delivery->complete_direct_video_job(*events, session_id, job_id, !gen.ok, gen.error,
                                          video_part, title, started_at);
    }
  }).detach();

  cs_log("direct t2v queued job=" + job_id, "info",
         json{{"job_id", job_id}, {"session_id", session_id}, {"gpu_mode", gpu_mode}});

  if (pipeline_) {
    pipeline_->set(json{{"subsystem", "direct_t2v"},
                        {"label", "Text-to-video"},
                        {"stage", "Generating"},
                        {"jobId", job_id},
                        {"updatedAt", now_ms()}});
  }

  std::ostringstream friendly;
  friendly << "Generating **" << title << "** with your text-to-video model (`" << job_id
           << "`). This runs in the background — I'll reload the chat model when it finishes.";
  json parts = json::array({direct_video_card_part(job_id, title, "running", started_at)});
  return tool_result_json(ToolResult{true, friendly.str(), parts});
}

json ContentStudioOrchestrator::submit_chat_render(std::map<std::string, std::string> merged,
                                                   const std::string& session_id,
                                                   const json& script,
                                                   const std::string& gpu_mode) {
  if (session_id.empty()) {
    return tool_result_json(
        ToolResult{false, "Save this chat session before starting Content Studio.", json::array()});
  }
  if (!script.is_object() || !script.contains("scenes")) {
    return tool_result_json(
        ToolResult{false, "Script is not ready — complete briefing choices first.", json::array()});
  }
  if (gpu_mode.empty()) {
    return tool_result_json(
        ToolResult{false, "Pick GPU mode (Keep agent loaded or Max performance) before render.",
                   json::array()});
  }

  const std::string theme = arg_str(merged, "theme", arg_str(merged, "topic"));
  const std::string title = arg_str(merged, "title", theme.substr(0, 80));

  if (delivery_) delivery_->cancel_active_jobs_for_session(session_id);
  if (content_studio_) content_studio_->wait_for_pipeline_idle(12000);

  std::string chat_model = arg_str(merged, "model_id");
  if (chat_model.empty()) chat_model = resolve_model_id();
  if (delivery_) {
    if (gpu_mode == "max_performance") {
      delivery_->prepare_max_performance_job(session_id, chat_model, title, theme);
    } else {
      delivery_->remember_reload_after_job(session_id, chat_model, title, theme);
    }
  }

  cs_log("submit_chat_render gpu=" + gpu_mode, "info",
         json{{"session_id", session_id}, {"title", title.substr(0, 80)}});
  const json body = build_run_body(merged, script);
  json run;
  try {
    run = content_studio_->api("POST", "/api/agent/v1/runs", body);
  } catch (const std::exception& e) {
    cs_log(std::string("submit_chat_render failed: ") + e.what(), "error",
           json{{"session_id", session_id}});
    return tool_result_json(ToolResult{false, e.what(), json::array()});
  }

  const std::string job_id = run.value("job_id", run.value("jobId", ""));
  const std::string project_id = run.value("project_id", run.value("projectId", ""));

  clear_pending(session_id);

  if (delivery_ && !job_id.empty() && !project_id.empty() && events_) {
    delivery_->track_job(job_id, session_id, project_id);
  }
  cs_log("run created job=" + job_id, "info",
         json{{"job_id", job_id}, {"project_id", project_id}, {"session_id", session_id}});

  if (pipeline_) {
    pipeline_->set(json{{"subsystem", "content_studio"},
                        {"label", "Content Studio"},
                        {"stage", "Pipeline queued"},
                        {"jobId", job_id},
                        {"updatedAt", now_ms()}});
  }

  if (events_) {
    events_->publish("omega:content-studio:changed",
                      json{{"phase", "run_created"}, {"jobId", job_id}, {"projectId", project_id}});
  }

  const std::string friendly = format_run_started_message(run, title);
  json parts = json::array({content_studio_card_part(run, title, now_ms())});
  return tool_result_json(ToolResult{true, friendly, parts});
}

json ContentStudioOrchestrator::create_run(const std::map<std::string, std::string>& args) {
  if (!content_studio_) {
    return tool_result_json(ToolResult{false, "Content Studio unavailable", json::array()});
  }

  const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
  const std::string resume_kind = arg_str(args, "__user_resume");
  const bool briefing_resume = resume_kind == "briefing";
  const bool gpu_resume = resume_kind == "gpu";

  std::map<std::string, std::string> merged_args =
      args_with_session_user_message(args, sessions_);
  std::string theme = arg_str(merged_args, "theme", arg_str(merged_args, "topic"));
  const std::string user_text =
      arg_str(merged_args, "user_message", arg_str(merged_args, "message"));
  if (theme.empty() && !user_text.empty()) {
    merged_args["theme"] = user_text;
    theme = user_text;
  }
  if (theme.empty() && arg_str(merged_args, "project_id").empty() && session_id.empty()) {
    return tool_result_json(ToolResult{false, "Provide theme/topic or project_id", json::array()});
  }

  try {
    content_studio_->ensure_started();
  } catch (const std::exception& e) {
    return tool_result_json(ToolResult{false, e.what(), json::array()});
  }

  sync_settings_to_api();

  std::map<std::string, std::string> merged = merged_args;
  if (!briefing_resume) merged.erase("briefing_confirmed");
  if (!gpu_resume) {
    merged.erase("agent_gpu_mode");
    merged.erase("project_id");
  }

  // Chat video from the agent tool: briefing only — never queue a render from the LLM path.
  if (!session_id.empty() && resume_kind.empty()) {
    return handle_llm_chat_video_request(merged, session_id);
  }

  std::string gpu_mode;
  if (gpu_resume) {
    gpu_mode = parse_gpu_mode(merged);
    if (gpu_mode.empty()) gpu_mode = arg_str(merged, "agent_gpu_mode");
  }

  json script = json::object();
  std::optional<PendingRun> pending = get_pending(session_id);
  if (pending) {
    if (pending->run_args.is_object()) {
      for (auto it = pending->run_args.begin(); it != pending->run_args.end(); ++it) {
        if (it.value().is_string() && merged[it.key()].empty()) {
          merged[it.key()] = it.value().get<std::string>();
        }
      }
    }
    if (pending->script.is_object()) script = pending->script;
  }

  const bool chat_session = !session_id.empty();

  if (chat_session && briefing_resume) {
    merged["briefing_confirmed"] = "true";
    cs_log("briefing resume → generate_script", "info", json{{"session_id", session_id}});
    return generate_script(merged);
  }

  if (chat_session && gpu_resume) {
    if (is_direct_t2v_producer(merged) || is_t2v_script(script)) {
      cs_log("gpu resume → submit_direct_t2v", "info",
             json{{"session_id", session_id}, {"gpu_mode", gpu_mode}});
      return submit_direct_t2v(merged, session_id, script, gpu_mode);
    }
    cs_log("gpu resume → submit_chat_render", "info",
           json{{"session_id", session_id}, {"gpu_mode", gpu_mode}});
    return submit_chat_render(merged, session_id, script, gpu_mode);
  }

  if (chat_session) {
    return tool_result_json(
        ToolResult{false, "Use briefing cards and GPU buttons in chat to run Content Studio.",
                   json::array()});
  }

  // Non-chat API callers (Content Studio page, integrations).
  if (gpu_mode.empty()) {
    gpu_mode = parse_gpu_mode(merged);
    if (gpu_mode.empty()) gpu_mode = arg_str(merged, "agent_gpu_mode");
  }

  if (script.empty() || !script.contains("scenes")) {
    return tool_result_json(
        ToolResult{false, "Script is not ready — provide script_content or use chat orchestration.",
                   json::array()});
  }

  const json body = build_run_body(merged, script);
  json run;
  try {
    run = content_studio_->api("POST", "/api/agent/v1/runs", body);
  } catch (const std::exception& e) {
    return tool_result_json(ToolResult{false, e.what(), json::array()});
  }

  const std::string title = arg_str(merged, "title", theme.substr(0, 80));
  const std::string friendly = format_run_started_message(run, title);
  json parts = json::array({content_studio_card_part(run, title, now_ms())});
  return tool_result_json(ToolResult{true, friendly, parts});
}

json ContentStudioOrchestrator::storage_report(const std::map<std::string, std::string>& args) const {
  const fs::path root = content_storage_root();
  json rows = json::array();
  uintmax_t total = 0;

  const std::string filter = arg_str(args, "project_id");
  if (!fs::exists(root)) {
    return tool_result_json(ToolResult{true, json{{"root", root.string()}, {"totalBytes", 0}, {"entries", rows}}.dump(2),
                                  json::array()});
  }

  std::error_code ec;
  for (const auto& entry : fs::directory_iterator(root, ec)) {
    if (ec || !entry.is_directory()) continue;
    const std::string pid = entry.path().filename().string();
    if (!filter.empty() && pid != filter) continue;
    const uintmax_t bytes = dir_size(entry.path());
    total += bytes;
    rows.push_back(json{{"projectId", pid}, {"bytes", bytes}});
  }

  json report{{"root", root.string()}, {"totalBytes", total}, {"entries", rows}};
  return tool_result_json(ToolResult{true, report.dump(2), json::array()});
}

json ContentStudioOrchestrator::storage_cleanup(const std::map<std::string, std::string>& args) const {
  const bool dry_run = arg_bool(args, "dry_run", true);
  const bool confirm = arg_bool(args, "confirm");
  if (!dry_run && !confirm) {
    return tool_result_json(ToolResult{false, "Pass confirm=true with dry_run=false to delete storage", json::array()});
  }

  const fs::path root = content_storage_root();
  if (!fs::exists(root)) {
    return tool_result_json(ToolResult{true, "No Content Studio storage directory", json::array()});
  }

  const std::string project_id = arg_str(args, "project_id");
  const std::string job_id = arg_str(args, "job_id");
  const int older_than_days = arg_int(args, "older_than_days", 0);
  const bool orphans_only = arg_bool(args, "orphins_only") || arg_bool(args, "orphans_only");

  json removed = json::array();
  const auto cutoff = std::chrono::system_clock::now() - std::chrono::hours(24 * older_than_days);

  auto maybe_remove = [&](const fs::path& path) {
    if (dry_run) {
      removed.push_back(path.string());
      return;
    }
    std::error_code ec;
    const auto count = fs::remove_all(path, ec);
    if (!ec) removed.push_back(json{{"path", path.string()}, {"bytesRemoved", count}});
  };

  if (!project_id.empty()) {
    fs::path target = root / project_id;
    if (job_id.empty()) {
      if (fs::exists(target)) maybe_remove(target);
    } else if (fs::exists(target / job_id)) {
      maybe_remove(target / job_id);
    }
  } else {
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(root, ec)) {
      if (ec || !entry.is_directory()) continue;
      if (older_than_days > 0) {
        const auto ftime = fs::last_write_time(entry.path(), ec);
        if (ec) continue;
        const auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
            ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now());
        if (sctp > cutoff) continue;
      }
      if (orphans_only) {
        // Without DB access, treat top-level project folders as candidates when orphans_only is set.
      }
      maybe_remove(entry.path());
    }
  }

  json out{{"dryRun", dry_run}, {"removed", removed}};
  return tool_result_json(ToolResult{true, out.dump(2), json::array()});
}

json ContentStudioOrchestrator::run_tool(const std::string& name,
                                         const std::map<std::string, std::string>& args) {
  if (!content_studio_) {
    return json{{"ok", false}, {"output", "Content Studio unavailable in native runtime"}};
  }

  try {
    content_studio_->ensure_started();
  } catch (const std::exception& e) {
    return json{{"ok", false}, {"output", e.what()}};
  }

  if (name == "content_create_run") {
    std::map<std::string, std::string> cleaned = args;
    // LLM must never pass internal resume flags — only try_resume_* calls create_run with them.
    cleaned.erase("__user_resume");
    cleaned.erase("project_id");
    cleaned.erase("agent_gpu_mode");
    cleaned.erase("briefing_confirmed");
    return create_run(cleaned);
  }

  if (name == "content_list_projects") {
    const json projects = content_studio_->api("GET", "/api/agent/v1/projects");
    return tool_result_json(ToolResult{true, projects.dump(2), json::array()});
  }

  if (name == "content_run_status") {
    const std::string job_id = arg_str(args, "job_id", arg_str(args, "jobId"));
    if (job_id.empty()) return tool_result_json(ToolResult{false, "job_id required", json::array()});
    const json st = content_studio_->api("GET", "/api/agent/v1/runs/" + job_id);
    return tool_result_json(ToolResult{true, st.dump(2), json::array()});
  }

  if (name == "content_delete_project") {
    std::string project_id = arg_str(args, "project_id");
    const std::string job_id = arg_str(args, "job_id", arg_str(args, "jobId"));
    if (project_id.empty() && !job_id.empty()) {
      const json st = content_studio_->api("GET", "/api/agent/v1/runs/" + job_id);
      project_id = st.value("project_id", st.value("projectId", ""));
    }
    if (project_id.empty()) return tool_result_json(ToolResult{false, "project_id or job_id required", json::array()});
    content_studio_->api("DELETE", "/api/agent/v1/projects/" + project_id);
    if (arg_bool(args, "delete_storage")) {
      std::map<std::string, std::string> cleanup_args{{"project_id", project_id},
                                                      {"dry_run", "false"},
                                                      {"confirm", "true"}};
      storage_cleanup(cleanup_args);
    }
    return tool_result_json(ToolResult{true, "deleted project " + project_id, json::array()});
  }

  if (name == "content_storage_report") return storage_report(args);
  if (name == "content_storage_cleanup") return storage_cleanup(args);

  if (name == "content_free_gpu") {
    sync_settings_to_api();
    json resp = content_studio_->api("POST", "/api/agent/v1/gpu/unload",
                                     json{{"reason", "content_free_gpu_tool"}});
    if (arg_bool(args, "reload_chat_model") && engine_) {
      const std::string model = resolve_model_id();
      if (!model.empty()) {
        try {
          engine_->ensure_started();
          engine_->command("model.load", json{{"modelId", model}, {"forceLoad", true}}, 600000);
        } catch (...) {
        }
      }
    }
    return tool_result_json(ToolResult{true, resp.dump(2), json::array()});
  }

  if (name == "content_schedule_list") {
    const json rows = content_studio_->api("GET", "/api/agent/v1/schedules");
    return tool_result_json(ToolResult{true, rows.dump(2), json::array()});
  }

  if (name == "content_schedule_create") {
    json body{{"cron_expression", arg_str(args, "cron_expression")},
              {"timezone", arg_str(args, "timezone", "UTC")},
              {"is_active", true}};
    put_if(body, "project_id", args, "project_id");
    put_if(body, "series_id", args, "series_id");
    const json created = content_studio_->api("POST", "/api/agent/v1/schedules", body);
    return tool_result_json(ToolResult{true, created.dump(2), json::array()});
  }

  if (name == "content_series_list") {
    const json rows = content_studio_->api("GET", "/api/agent/v1/series");
    return tool_result_json(ToolResult{true, rows.dump(2), json::array()});
  }

  if (name == "content_series_create") {
    json body{{"title", arg_str(args, "title")}, {"theme", arg_str(args, "theme")}};
    put_int_if(body, "default_max_duration_seconds", args, "default_max_duration_seconds");
    const json created = content_studio_->api("POST", "/api/agent/v1/series", body);
    return tool_result_json(ToolResult{true, created.dump(2), json::array()});
  }

  if (name == "content_social_platforms") {
    const json rows = content_studio_->api("GET", "/api/social/platforms");
    return tool_result_json(ToolResult{true, rows.dump(2), json::array()});
  }

  if (name == "content_social_publish") {
    json body{{"platform", arg_str(args, "platform")},
              {"title", arg_str(args, "title")},
              {"caption", arg_str(args, "caption", "")},
              {"publish_now", arg_bool(args, "publish_now")}};
    put_if(body, "project_id", args, "project_id");
    const json created = content_studio_->api("POST", "/api/social/posts", body);
    return tool_result_json(ToolResult{true, created.dump(2), json::array()});
  }

  return json{{"ok", false}, {"output", "content tool not implemented natively: " + name}};
}

std::optional<json> ContentStudioOrchestrator::try_resume_after_briefing_choice(
    const std::string& session_id, const std::string& user_message) {
  if (session_id.empty() || user_message.empty()) return std::nullopt;
  if (!parse_gpu_mode({{"user_message", user_message}}).empty()) return std::nullopt;

  const auto pending = get_pending(session_id);
  if (!pending) return std::nullopt;

  if (pending->phase == "awaiting_gpu" && looks_like_briefing_reply(user_message)) {
    std::map<std::string, std::string> args = json_to_run_args(pending->run_args);
    args["sessionId"] = session_id;
    args["session_id"] = session_id;
    args["user_message"] = user_message;
    merge_briefing_from_message(user_message, args);
    PendingRun updated = *pending;
    updated.run_args = run_args_to_json(args);
    set_pending(session_id, std::move(updated));
    return generate_script(args);
  }

  if (pending->phase == "producer_choice") {
    std::map<std::string, std::string> args = json_to_run_args(pending->run_args);
    args["sessionId"] = session_id;
    args["session_id"] = session_id;
    args["user_message"] = user_message;
    merge_briefing_from_message(user_message, args);
    if (is_direct_t2v_producer(args)) {
      return generate_t2v_prompt(args);
    }
    PendingRun updated;
    updated.phase = "briefing";
    updated.run_args = run_args_to_json(args);
    updated.run_args["video_producer"] = "content_studio";
    set_pending(session_id, std::move(updated));
    return tool_result_json(
        ToolResult{true, build_briefing_choices(args), json::array()});
  }

  if (pending->phase == "briefing") {
    if (pending->script.is_object() && pending->script.contains("scenes")) return std::nullopt;
    std::map<std::string, std::string> args = json_to_run_args(pending->run_args);
    args["sessionId"] = session_id;
    args["session_id"] = session_id;
    args["user_message"] = user_message;
    merge_briefing_from_message(user_message, args);
    args["__user_resume"] = "briefing";
    return create_run(args);
  }

  return std::nullopt;
}

std::optional<json> ContentStudioOrchestrator::try_resume_after_gpu_choice(
    const std::string& session_id, const std::string& user_message) {
  if (session_id.empty() || user_message.empty()) return std::nullopt;
  const auto pending = get_pending(session_id);
  if (!pending || !pending->script.is_object()) return std::nullopt;
  const bool cs_script = pending->script.contains("scenes");
  const bool t2v_script = is_t2v_script(pending->script);
  if (!cs_script && !t2v_script) return std::nullopt;

  std::map<std::string, std::string> args{{"sessionId", session_id}, {"session_id", session_id},
                                          {"user_message", user_message}};
  const std::string gpu_mode = parse_gpu_mode(args);
  if (gpu_mode.empty()) return std::nullopt;
  args["agent_gpu_mode"] = gpu_mode;
  args["__user_resume"] = "gpu";
  if (pending->run_args.is_object()) {
    for (auto it = pending->run_args.begin(); it != pending->run_args.end(); ++it) {
      if (!it.value().is_string()) continue;
      if (args[it.key()].empty()) args[it.key()] = it.value().get<std::string>();
    }
  }
  return create_run(args);
}

}  // namespace omega::runtime
