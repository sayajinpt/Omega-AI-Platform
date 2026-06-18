#include "omega/runtime/services/chat_tts_orchestrator.hpp"

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string arg_str(const std::map<std::string, std::string>& args, const std::string& key,
                    const std::string& fallback = "") {
  const auto it = args.find(key);
  return it == args.end() ? fallback : it->second;
}

std::string trim_copy(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == ' ' || s.back() == '\r')) s.pop_back();
  while (!s.empty() && (s.front() == '\n' || s.front() == ' ' || s.front() == '\r')) s.erase(s.begin());
  return s;
}

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

json tool_ok(const std::string& output, const json& parts = json::array()) {
  json out{{"ok", true}, {"output", output}};
  if (parts.is_array() && !parts.empty()) out["parts"] = parts;
  return out;
}

json tool_err(const std::string& msg) { return json{{"ok", false}, {"output", msg}}; }

std::string choice_block(const std::string& prompt, const json& options) {
  json payload{{"prompt", prompt}, {"allowCustom", true}, {"options", options}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

std::string textarea_block(const std::string& prompt) {
  json payload{{"prompt", prompt},
               {"allowCustom", true},
               {"inputKind", "textarea"},
               {"options", json::array()}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

bool contains_tts_choice_tokens(const std::string& msg) {
  static const std::regex re(
      R"(\b(tts_voice_gender|voice_gender|tts_language|narration_tone|tts_pitch|tts_instruct)\s*:)",
      std::regex_constants::icase);
  return std::regex_search(msg, re);
}

void merge_tts_token(const std::string& token, std::map<std::string, std::string>& args) {
  const size_t colon = token.find(':');
  if (colon != std::string::npos) {
    const std::string key = lower_copy(trim_copy(token.substr(0, colon)));
    const std::string val = trim_copy(token.substr(colon + 1));
    if (val.empty()) return;
    if (key == "voice_gender" || key == "tts_voice_gender") args["tts_voice_gender"] = val;
    else if (key == "tts_language" || key == "language") args["tts_language"] = val;
    else if (key == "narration_tone" || key == "tone" || key == "tts_instruct") args["narration_tone"] = val;
    else if (key == "tts_pitch" || key == "pitch") args["tts_pitch"] = val;
    else if (key == "text" || key == "prompt") args["text"] = val;
    return;
  }
  if (arg_str(args, "text").empty() && token.size() >= 2) args["text"] = token;
}

void merge_tts_from_message(const std::string& user_message,
                            std::map<std::string, std::string>& args) {
  static const std::regex key_re(
      R"(\b(tts_voice_gender|voice_gender|tts_language|narration_tone|tts_pitch|tts_instruct|text|prompt)\s*:)",
      std::regex_constants::icase);
  std::istringstream lines(user_message);
  std::string line;
  while (std::getline(lines, line)) {
    line = trim_copy(line);
    if (line.empty()) continue;
    std::vector<size_t> starts;
    for (std::sregex_iterator it(line.begin(), line.end(), key_re), end; it != end; ++it) {
      starts.push_back(static_cast<size_t>(it->position()));
    }
    if (starts.empty()) {
      merge_tts_token(line, args);
      continue;
    }
    for (size_t i = 0; i < starts.size(); ++i) {
      const size_t begin = starts[i];
      const size_t end = (i + 1 < starts.size()) ? starts[i + 1] : line.size();
      std::string piece = trim_copy(line.substr(begin, end - begin));
      if (!piece.empty()) merge_tts_token(piece, args);
    }
  }
}

std::string extract_tts_text(const std::string& user_message,
                             const std::map<std::string, std::string>& args) {
  std::string t = arg_str(args, "text");
  if (t.empty()) t = arg_str(args, "prompt");
  if (!t.empty()) return t;
  if (user_message.empty()) return "";

  static const std::regex quoted(R"re("([^"]{2,})"|'([^']{2,})')re");
  std::smatch m;
  if (std::regex_search(user_message, m, quoted)) {
    return m[1].matched ? m[1].str() : m[2].str();
  }

  static const std::regex say_re(
      R"(\b(?:say|speak|narrate|read(?:\s+aloud)?)\s*[:—-]\s*(.+)$)",
      std::regex_constants::icase);
  if (std::regex_search(user_message, m, say_re) && m.size() >= 2) {
    return trim_copy(m[1].str());
  }

  return "";
}

std::string build_tts_instruct(const std::map<std::string, std::string>& args) {
  std::ostringstream ins;
  const std::string tone = arg_str(args, "narration_tone", arg_str(args, "tts_instruct"));
  const std::string pitch = lower_copy(arg_str(args, "tts_pitch"));
  if (!tone.empty()) ins << tone;
  if (!pitch.empty()) {
    if (pitch == "low" || pitch == "deep") {
      if (!ins.str().empty()) ins << ' ';
      ins << "Use a low, deep pitch.";
    } else if (pitch == "high") {
      if (!ins.str().empty()) ins << ' ';
      ins << "Use a higher pitch.";
    } else if (pitch != "normal" && pitch != "default") {
      if (!ins.str().empty()) ins << ' ';
      ins << "Pitch: " << pitch;
    }
  }
  return ins.str();
}

std::string tts_options_blocks(const std::map<std::string, std::string>& args, bool include_text_card) {
  std::ostringstream out;
  out << "Configure the voice (pick options below or type your own answer in the composer).\n\n";

  out << choice_block(
             "Voice gender",
             json::array({json{{"id", "vg-any"},
                               {"label", "Any / auto"},
                               {"value", "tts_voice_gender:any"}},
                          json{{"id", "vg-male"},
                               {"label", "Male"},
                               {"value", "tts_voice_gender:male"}},
                          json{{"id", "vg-female"},
                               {"label", "Female"},
                               {"value", "tts_voice_gender:female"}}}))
      << "\n\n";

  out << choice_block(
             "Language",
             json::array({json{{"id", "lang-en"},
                               {"label", "English"},
                               {"value", "tts_language:English"}},
                          json{{"id", "lang-pt"},
                               {"label", "Portuguese"},
                               {"value", "tts_language:Portuguese"}},
                          json{{"id", "lang-es"},
                               {"label", "Spanish"},
                               {"value", "tts_language:Spanish"}},
                          json{{"id", "lang-fr"},
                               {"label", "French"},
                               {"value", "tts_language:French"}},
                          json{{"id", "lang-de"},
                               {"label", "German"},
                               {"value", "tts_language:German"}}}))
      << "\n\n";

  out << choice_block(
             "Tone / delivery",
             json::array({json{{"id", "tone-warm"},
                               {"label", "Warm & friendly"},
                               {"value", "narration_tone:warm and friendly"}},
                          json{{"id", "tone-energetic"},
                               {"label", "Energetic"},
                               {"value", "narration_tone:energetic and upbeat"}},
                          json{{"id", "tone-calm"},
                               {"label", "Calm & measured"},
                               {"value", "narration_tone:calm measured documentary"}},
                          json{{"id", "tone-news"},
                               {"label", "News / professional"},
                               {"value", "narration_tone:professional news anchor"}}}))
      << "\n\n";

  out << choice_block(
             "Pitch",
             json::array({json{{"id", "pitch-normal"},
                               {"label", "Normal"},
                               {"value", "tts_pitch:normal"}},
                          json{{"id", "pitch-low"},
                               {"label", "Low / deep"},
                               {"value", "tts_pitch:low"}},
                          json{{"id", "pitch-high"},
                               {"label", "Higher"},
                               {"value", "tts_pitch:high"}}}))
      << "\n\n";

  if (include_text_card) {
    out << textarea_block("What text should I speak? Paste or type the full script below.");
  } else {
    const std::string text = arg_str(args, "text");
    if (!text.empty()) {
      const std::string preview = text.size() > 160 ? text.substr(0, 157) + "..." : text;
      out << "I'll speak:\n> " << preview << "\n\n";
    }
  }
  return out.str();
}

bool tts_args_have_text(const std::map<std::string, std::string>& args) {
  return !arg_str(args, "text").empty();
}

bool user_provided_tts_options(const std::map<std::string, std::string>& args,
                               const std::string& user_message) {
  if (contains_tts_choice_tokens(user_message)) return true;
  return !arg_str(args, "tts_voice_gender").empty() || !arg_str(args, "voice_gender").empty() ||
         !arg_str(args, "tts_language").empty() || !arg_str(args, "narration_tone").empty() ||
         !arg_str(args, "tts_pitch").empty() || !arg_str(args, "tts_instruct").empty();
}

}  // namespace

void ChatTtsOrchestrator::attach(ConfigStore* config, EngineClient* engine, ProjectStore* projects,
                                 MediaPlayerService* media) {
  config_ = config;
  engine_ = engine;
  projects_ = projects;
  media_ = media;
}

std::optional<ChatTtsOrchestrator::PendingTts> ChatTtsOrchestrator::get_pending(
    const std::string& session_id) const {
  std::lock_guard lock(mu_);
  const auto it = pending_.find(session_id);
  if (it == pending_.end()) return std::nullopt;
  return it->second;
}

void ChatTtsOrchestrator::set_pending(const std::string& session_id, PendingTts pending) {
  std::lock_guard lock(mu_);
  pending_[session_id] = std::move(pending);
}

void ChatTtsOrchestrator::clear_pending(const std::string& session_id) {
  std::lock_guard lock(mu_);
  pending_.erase(session_id);
}

void ChatTtsOrchestrator::discard_session(const std::string& session_id) {
  clear_pending(session_id);
}

json ChatTtsOrchestrator::synthesize(const std::map<std::string, std::string>& args) {
  if (!projects_ || !config_) return tool_err("audio generate unavailable");
  const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
  const std::string text = arg_str(args, "text");
  if (session_id.empty() || text.empty()) return tool_err("sessionId and text required");

  const json cfg = config_->load();
  const std::string model_arg = arg_str(args, "modelId", arg_str(args, "model_id"));

  projects_->ensure_dir(session_id);
  const fs::path media_dir = fs::path(projects_->open_folder(session_id)) / "media";
  fs::create_directories(media_dir);
  const std::string filename = random_uuid().substr(0, 12) + ".wav";
  const fs::path dest = media_dir / filename;

  TtsSynthesisOptions opts;
  opts.voice_gender = arg_str(args, "tts_voice_gender", arg_str(args, "voice_gender", "any"));
  opts.language = arg_str(args, "tts_language", "English");
  opts.speaker = arg_str(args, "tts_speaker", "Ryan");
  opts.instruct = build_tts_instruct(args);

  TtsGenerateResult gen =
      MediaExecutor::generate_tts(engine_, cfg, model_arg, text, dest.string(), opts);
  if (!gen.ok) {
    const std::string err =
        gen.error.empty() ? "I couldn't synthesize that speech on this device." : gen.error;
    return tool_err(err);
  }

  const fs::path wav_path = gen.wav_path.empty() ? dest : fs::path(gen.wav_path);
  if (!fs::exists(wav_path) || fs::file_size(wav_path) == 0) {
    return tool_err("Speech synthesis finished but the saved file is empty.");
  }

  const std::string ref = filename;
  json part{{"type", "audio"}, {"ref", ref}, {"alt", text.substr(0, 120)}};
  if (media_) {
    media_->show_preview(json{{"sessionId", session_id}, {"part", part}});
  }
  std::string label = gen.backend;
  if (label == "engine") label = "omega-engine";
  if (gen.studio_fallback) label += " (Content Studio voice)";
  return tool_ok("[Audio: " + ref + "] (" + label + ")", json::array({part}));
}

json ChatTtsOrchestrator::run_tool(const std::map<std::string, std::string>& args) {
  std::map<std::string, std::string> merged = args;
  const std::string session_id = arg_str(merged, "sessionId", arg_str(merged, "session_id"));
  const std::string user_msg = arg_str(merged, "user_message");

  const std::string extracted = extract_tts_text(user_msg, merged);
  if (!extracted.empty()) merged["text"] = extracted;

  if (!tts_args_have_text(merged)) {
    PendingTts pending;
    pending.args = merged;
    pending.awaiting_options = false;
    if (!session_id.empty()) set_pending(session_id, std::move(pending));
    return tool_ok(tts_options_blocks(merged, true));
  }

  if (!user_provided_tts_options(merged, user_msg)) {
    PendingTts pending;
    pending.args = merged;
    pending.awaiting_options = true;
    if (!session_id.empty()) set_pending(session_id, std::move(pending));
    return tool_ok(tts_options_blocks(merged, false));
  }

  if (!session_id.empty()) clear_pending(session_id);
  return synthesize(merged);
}

std::optional<json> ChatTtsOrchestrator::try_resume_after_choice(const std::string& session_id,
                                                                 const std::string& user_message) {
  if (session_id.empty() || user_message.empty()) return std::nullopt;
  const auto pending = get_pending(session_id);
  if (!pending) return std::nullopt;

  std::map<std::string, std::string> args = pending->args;
  args["sessionId"] = session_id;
  args["session_id"] = session_id;
  merge_tts_from_message(user_message, args);

  const std::string extracted = extract_tts_text(user_message, args);
  if (!extracted.empty()) args["text"] = extracted;

  if (!tts_args_have_text(args)) {
    PendingTts updated;
    updated.args = args;
    updated.awaiting_options = pending->awaiting_options;
    set_pending(session_id, std::move(updated));
    json tr = tool_ok(tts_options_blocks(args, true));
    tr["tool"] = "audio_generate";
    return tr;
  }

  if (pending->awaiting_options && !user_provided_tts_options(args, user_message)) {
    const bool plain_reply =
        !contains_tts_choice_tokens(user_message) && user_message.find(':') == std::string::npos;
    if (plain_reply && tts_args_have_text(args)) {
      clear_pending(session_id);
      json tr = synthesize(args);
      tr["tool"] = "audio_generate";
      return tr;
    }
    PendingTts updated;
    updated.args = args;
    updated.awaiting_options = true;
    set_pending(session_id, std::move(updated));
    json tr = tool_ok(tts_options_blocks(args, false));
    tr["tool"] = "audio_generate";
    return tr;
  }

  clear_pending(session_id);
  json tr = synthesize(args);
  tr["tool"] = "audio_generate";
  return tr;
}

}  // namespace omega::runtime
