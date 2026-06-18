#include "omega/runtime/orchestrator/tool_catalog.hpp"

#include <algorithm>
#include <cctype>
#include <unordered_map>
#include <set>

namespace omega::runtime {

namespace {

std::string lower(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

const std::unordered_map<std::string, std::string>& aliases() {
  static const std::unordered_map<std::string, std::string> k = {
      {"generate", "image_generate"},
      {"create_image", "image_generate"},
      {"make_image", "image_generate"},
      {"draw_image", "image_generate"},
      {"generate_image", "image_generate"},
      {"image_create", "image_generate"},
      {"dalle", "image_generate"},
      {"tts", "audio_generate"},
      {"text_to_speech", "audio_generate"},
      {"speak", "audio_generate"},
      {"narrate", "audio_generate"},
      {"voiceover", "audio_generate"},
      {"content_studio", "content_create_run"},
      {"content_studio_run", "content_create_run"},
      {"create_video", "content_create_run"},
      {"make_video", "content_create_run"},
      {"play_music", "play_youtube"},
      {"youtube_play", "play_youtube"},
      {"search_web", "web_search"},
      {"google", "web_search"},
      {"list_tool", "list_tools"},
      {"tools_list", "list_tools"},
      {"read_chat", "chat_read_cache"},
      {"chat_history", "chat_read_cache"},
  };
  return k;
}

const std::unordered_map<std::string, const char*>& tool_cards() {
  static const std::unordered_map<std::string, const char*> k = {
      {"chat_choice_card",
       "Show a choices UI when required parameters are missing. Args: prompt (string), options "
       "(JSON array of {id,label,value,description}), allow_custom (bool). Build options for "
       "what you still need (tone, language, target platform, song title, image style, etc.) — "
       "never reuse generic hardcoded menus."},
      {"chat_read_cache",
       "Read prior messages from a chat. Args: sessionId (optional, default current), limit "
       "(int, default 20). Use when the user input is ambiguous or refers to earlier context."},
      {"chat_manage",
       "Create/list/delete/rename chats. Args: action (create|list|delete|rename), sessionId, "
       "title."},
      {"chat_list", "List recent chat sessions (same as chat_manage action=list)."},
      {"image_generate",
       "Create a still image from a text prompt and show it in chat. Args: sessionId, prompt. "
       "Use for requests like draw/create/generate an image, picture, illustration, sunset, "
       "portrait. Requires sessionId — use the active chat session."},
      {"audio_generate",
       "Synthesize speech (TTS) and show an audio player in chat. Args: sessionId; optional text, "
       "tts_voice_gender, tts_language, narration_tone, tts_pitch. Runtime shows voice option cards "
       "and a text input when the script is missing."},
      {"content_create_run",
       "Queue a Content Studio video from chat. Args: theme (required); optional max_duration_seconds "
       "when the user stated length (e.g. \"10 second clip\" → 10). sessionId is auto-injected from "
       "the active chat — omit it. Runtime shows briefing, script, then GPU mode — never pass "
       "project_id, agent_gpu_mode, or briefing_confirmed."},
      {"content_run_status", "Check a Content Studio run. Args: runId or jobId."},
      {"content_list_projects", "List Content Studio projects/runs."},
      {"play_youtube",
       "Stream audio/video from YouTube in the chat media player. Args: query or url."},
      {"play_local_media", "Play a file from this PC in chat. Args: path or query."},
      {"search_local_media", "Search Music/Videos/Downloads for media files. Args: query."},
      {"media_stop", "Stop playback."},
      {"media_status", "What is currently playing."},
      {"web_search", "Search the web. Args: query."},
      {"web_fetch", "Fetch a URL as text. Args: url."},
      {"browser_navigate", "Open a URL in the in-app browser. Args: url."},
      {"browser_snapshot", "Read the current browser page text. Args: (none)."},
      {"read_file", "Read a file. Args: path."},
      {"write_file",
       "Write a file in the current chat project. Required args: path (relative, e.g. code/asteroids.html), "
       "content (full file text). Bare filenames like game.html are stored under code/."},
      {"list_dir", "List a directory. Args: path."},
      {"grep_files", "Search file contents. Args: pattern, path."},
      {"glob_files", "Find files by glob. Args: pattern, path."},
      {"run_python",
       "Execute Python in the unified venv. Args: code (inline) OR path (e.g. code/script.py) "
       "with sessionId. Use after write_file to test scripts. Requires user approval."},
      {"run_shell",
       "Run a shell command and return stdout/stderr in the chat terminal. Args: command (required); "
       "optional cwd. Use for ping, ipconfig, dir, git, npm, etc. Requires shell permission approval."},
      {"run_process",
       "Launch a program with args (no shell). Args: executable (required); optional argsJson (JSON "
       "array of strings), cwd. Requires shell permission approval."},
      {"search_memory", "Search long-term memory. Args: query."},
      {"add_memory", "Save a memory fact. Args: content."},
      {"list_tools", "List all tools you may call (use when unsure)."},
      {"omega_capabilities", "Summarize capability groups and tools."},
      {"inference_status", "Engine/model load status."},
      {"list_models", "List installed models."},
  };
  return k;
}

}  // namespace

std::string normalize_orchestrator_tool_name(std::string name) {
  name = lower(name);
  while (!name.empty() && (name.front() == '_' || name.front() == ' ')) name.erase(name.begin());
  while (!name.empty() && (name.back() == ' ' || name.back() == '_')) name.pop_back();
  const auto& a = aliases();
  const auto it = a.find(name);
  if (it != a.end()) return it->second;
  return name;
}

bool orchestrator_tool_name_is_known(const std::string& name) {
  if (name.empty()) return false;
  static const std::set<std::string> k_placeholders = {
      "tool", "json", "tool json", "tool_json", "tool_name", "tool_call", "tool_calls",
      "function", "functions", "name", "args", "arguments"};
  const std::string canon = normalize_orchestrator_tool_name(name);
  if (k_placeholders.count(canon)) return false;
  for (const auto& t : orchestrator_tool_names()) {
    if (t == canon) return true;
  }
  return false;
}

std::vector<std::string> orchestrator_tool_names() {
  return {
      "chat_choice_card",   "chat_read_cache",    "chat_manage",        "chat_list",
      "image_generate",     "audio_generate",     "content_create_run", "content_run_status", "content_list_projects",
      "play_youtube",       "play_local_media",   "search_local_media", "media_stop",
      "media_status",       "web_search",         "web_fetch",          "browser_navigate",
      "browser_snapshot",   "read_file",          "write_file",         "list_dir",
      "grep_files",         "glob_files",         "run_python",         "run_shell",
      "run_process",        "search_memory",      "add_memory",         "list_tools",
      "omega_capabilities", "inference_status",   "list_models",
  };
}

std::string orchestrator_tool_card(const std::string& tool_name) {
  const std::string canon = normalize_orchestrator_tool_name(tool_name);
  const auto& cards = tool_cards();
  const auto it = cards.find(canon);
  if (it != cards.end()) return it->second;
  return "Call with JSON args appropriate for the briefing. Use list_tools if unsure of parameters.";
}

}  // namespace omega::runtime
