#include "omega/runtime/services/media_player_service.hpp"

#include <algorithm>
#include <cctype>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

bool path_has_audio_ext(const std::string& path) {
  const auto dot = path.find_last_of('.');
  if (dot == std::string::npos) return false;
  std::string ext = path.substr(dot);
  std::transform(ext.begin(), ext.end(), ext.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  static const char* k_audio[] = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma", ".opus"};
  for (const char* a : k_audio) {
    if (ext == a) return true;
  }
  return false;
}

}  // namespace

MediaPlayerService::MediaPlayerService(EventBus& events) : events_(events) {
  now_playing_ = json{{"kind", "idle"}, {"title", ""}};
}

json MediaPlayerService::state() const {
  std::lock_guard lock(mu_);
  return now_playing_;
}

void MediaPlayerService::broadcast() const {
  events_.publish("omega:media:state", now_playing_);
}

json MediaPlayerService::stop() {
  std::lock_guard lock(mu_);
  now_playing_ = json{{"kind", "idle"}, {"title", ""}, {"playing", false}};
  broadcast();
  return json{{"ok", true}, {"output", "stopped"}};
}

void MediaPlayerService::stop_if_session(const std::string& session_id) {
  if (session_id.empty()) return;
  std::lock_guard lock(mu_);
  if (now_playing_.value("sessionId", "") != session_id) return;
  now_playing_ = json{{"kind", "idle"}, {"title", ""}, {"playing", false}};
  broadcast();
}

json MediaPlayerService::pause() {
  std::lock_guard lock(mu_);
  if (now_playing_.value("kind", "idle") == "idle") {
    return json{{"ok", true}, {"output", "idle"}};
  }
  now_playing_["playing"] = false;
  broadcast();
  return json{{"ok", true}, {"output", "paused"}};
}

json MediaPlayerService::resume() {
  std::lock_guard lock(mu_);
  if (now_playing_.value("kind", "idle") == "idle") {
    return json{{"ok", false}, {"output", "nothing playing"}};
  }
  now_playing_["playing"] = true;
  broadcast();
  return json{{"ok", true}, {"output", "playing"}};
}

json MediaPlayerService::show_preview(const json& body) {
  const std::string session_id = body.value("sessionId", body.value("session_id", ""));
  const json part = body.value("part", body);
  std::lock_guard lock(mu_);
  if (part.value("type", "") == "image") {
    now_playing_ = json{{"kind", "preview"},
                        {"previewType", "image"},
                        {"sessionId", session_id},
                        {"mediaRef", part.value("ref", "")},
                        {"title", part.value("alt", "Generated image")},
                        {"playing", false},
                        {"embedInChat", true}};
  } else if (part.value("type", "") == "video") {
    now_playing_ = json{{"kind", "preview"},
                        {"previewType", "video"},
                        {"sessionId", session_id},
                        {"mediaRef", part.value("ref", "")},
                        {"title", "Generated video"},
                        {"playing", true},
                        {"embedInChat", true}};
  } else if (part.value("type", "") == "audio") {
    now_playing_ = json{{"kind", "preview"},
                        {"previewType", "audio"},
                        {"sessionId", session_id},
                        {"mediaRef", part.value("ref", "")},
                        {"title", "Generated audio"},
                        {"playing", true},
                        {"embedInChat", true}};
  } else {
    now_playing_ = json{{"kind", "preview"},
                        {"previewType", "file"},
                        {"sessionId", session_id},
                        {"mediaRef", part.value("ref", "")},
                        {"title", part.value("name", "File")},
                        {"playing", false},
                        {"embedInChat", true}};
  }
  broadcast();
  return json{{"ok", true}};
}

json MediaPlayerService::play_local_path(const std::string& path, const std::string& title) {
  std::lock_guard lock(mu_);
  const std::string display = title.empty() ? path : title;
  if (path_has_audio_ext(path)) {
    now_playing_ = json{{"kind", "preview"},
                        {"previewType", "audio"},
                        {"path", path},
                        {"title", display},
                        {"playing", true},
                        {"embedInChat", true}};
  } else {
    now_playing_ = json{{"kind", "local"},
                        {"path", path},
                        {"title", display},
                        {"playing", true},
                        {"embedInChat", false}};
  }
  broadcast();
  return json{{"ok", true}, {"path", path}};
}

json MediaPlayerService::play_youtube_url(const std::string& url, const std::string& title,
                                          const std::string& embed_url, bool embed_in_chat) {
  std::lock_guard lock(mu_);
  const bool can_embed = embed_in_chat && !embed_url.empty();
  now_playing_ = json{{"kind", "youtube"},
                      {"url", can_embed ? embed_url : url},
                      {"watchUrl", url},
                      {"title", title.empty() ? "YouTube" : title},
                      {"playing", true},
                      {"embedInChat", can_embed}};
  if (!embed_url.empty()) now_playing_["embedUrl"] = embed_url;
  broadcast();
  return json{{"ok", true}, {"url", url}};
}

}  // namespace omega::runtime
