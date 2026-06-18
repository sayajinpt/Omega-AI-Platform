#include "omega/runtime/tools/agent_desktop_tools.hpp"

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/services/desktop_aux_service.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/tools/sandbox.hpp"
#include "omega/runtime/tools/tool_registry.hpp"
#include "omega/runtime/net/https_client.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <iomanip>
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

bool arg_bool(const std::map<std::string, std::string>& args, const std::string& key,
              bool fallback = false) {
  const std::string v = arg_str(args, key);
  if (v.empty()) return fallback;
  const char c = static_cast<char>(std::tolower(static_cast<unsigned char>(v[0])));
  return v == "1" || v == "true" || v == "yes" || c == 't' || c == 'y';
}

json tool_ok(const std::string& output, const json& parts = json::array()) {
  json out{{"ok", true}, {"output", output}};
  if (parts.is_array() && !parts.empty()) out["parts"] = parts;
  return out;
}

json tool_err(const std::string& msg) { return json{{"ok", false}, {"output", msg}}; }

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

bool filename_matches_query(const std::string& filename, const std::string& query) {
  if (query.empty()) return true;
  const std::string f = lower_copy(filename);
  const std::string q = lower_copy(query);
  return f.find(q) != std::string::npos;
}

bool is_media_ext(const fs::path& path, bool audio_only) {
  const std::string ext = lower_copy(path.extension().string());
  static const char* k_audio[] = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"};
  static const char* k_video[] = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"};
  for (const char* a : k_audio) {
    if (ext == a) return true;
  }
  if (audio_only) return false;
  for (const char* v : k_video) {
    if (ext == v) return true;
  }
  return false;
}

std::vector<fs::path> default_media_roots() {
  std::vector<fs::path> roots;
#ifdef _WIN32
  const char* profile = std::getenv("USERPROFILE");
  if (profile && *profile) {
    const fs::path home = profile;
    roots.push_back(home / "Music");
    roots.push_back(home / "Videos");
    roots.push_back(home / "Downloads");
  }
#else
  const char* home = std::getenv("HOME");
  if (home && *home) {
    const fs::path h = home;
    roots.push_back(h / "Music");
    roots.push_back(h / "Videos");
    roots.push_back(h / "Downloads");
  }
#endif
  return roots;
}

json search_media_files(const std::string& query, const std::string& folder, bool audio_only,
                        int limit) {
  json hits = json::array();
  std::vector<fs::path> roots;
  if (!folder.empty() && fs::exists(folder)) {
    roots.push_back(fs::path(folder));
  } else {
    roots = default_media_roots();
  }

  for (const auto& root : roots) {
    if (!fs::exists(root)) continue;
    std::error_code ec;
    for (fs::recursive_directory_iterator it(root, ec), end;
         it != end && hits.size() < static_cast<size_t>(limit); it.increment(ec)) {
      if (ec || !it->is_regular_file(ec)) continue;
      if (!is_media_ext(it->path(), audio_only)) continue;
      if (!filename_matches_query(it->path().filename().string(), query)) continue;
      hits.push_back(json{{"path", it->path().string()},
                          {"name", it->path().filename().string()},
                          {"size", it->file_size(ec)}});
    }
  }
  return hits;
}

std::string url_encode(const std::string& value) {
  std::ostringstream escaped;
  escaped.fill('0');
  escaped << std::hex;
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      escaped << c;
    } else {
      escaped << '%' << std::setw(2) << int(c);
    }
  }
  return escaped.str();
}

std::string extract_youtube_video_id(const std::string& url) {
  static const std::regex watch_re(R"(([?&]v=|youtu\.be/|/embed/)([a-zA-Z0-9_-]{11}))");
  std::smatch m;
  if (std::regex_search(url, m, watch_re) && m.size() >= 3) return m[2].str();
  return {};
}

std::string youtube_watch_url(const std::string& video_id) {
  if (video_id.empty()) return {};
  return "https://www.youtube.com/watch?v=" + video_id;
}

https::RequestOptions desktop_http_opts() {
  https::RequestOptions opts;
  opts.connection_timeout_sec = 10;
  opts.read_timeout_sec = 25;
  opts.follow_redirects = true;
  opts.headers = {
      {"User-Agent",
       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
      {"Accept-Language", "en-US,en;q=0.9"}};
  return opts;
}

std::string resolve_youtube_watch_from_query(const std::string& query) {
  if (query.empty()) return {};
  const std::string search_url =
      "https://www.youtube.com/results?search_query=" + url_encode(query);
  try {
    const https::HttpResponse res = https::get(search_url, desktop_http_opts());
    if (res.status < 200 || res.status >= 400) return search_url;
    static const std::regex id_re(R"pat("videoId"\s*:\s*"([a-zA-Z0-9_-]{11})")pat");
    std::sregex_iterator it(res.body.begin(), res.body.end(), id_re);
    const std::sregex_iterator end;
    for (; it != end; ++it) {
      if (it->size() < 2) continue;
      const std::string id = (*it)[1].str();
      if (id == "undefined" || id.find("http") != std::string::npos) continue;
      return youtube_watch_url(id);
    }
    static const std::regex id_re2(R"((?:watch\?v=|/embed/|youtu\.be/)([a-zA-Z0-9_-]{11}))");
    std::smatch m;
    if (std::regex_search(res.body, m, id_re2) && m.size() >= 2) {
      return youtube_watch_url(m[1].str());
    }
  } catch (...) {
  }
  return search_url;
}

std::string build_youtube_url(const std::string& query, const std::string& url) {
  if (!url.empty()) {
    const std::string id = extract_youtube_video_id(url);
    return id.empty() ? url : youtube_watch_url(id);
  }
  if (query.empty()) return "";
  return resolve_youtube_watch_from_query(query);
}

std::string choices_block(const std::string& prompt, const json& options, bool allow_custom) {
  json payload{{"prompt", prompt}, {"allowCustom", allow_custom}, {"options", options}};
  return "```choices\n" + payload.dump(2) + "\n```";
}

}  // namespace

void AgentDesktopTools::attach(ConfigStore* config, EngineClient* engine, MediaPlayerService* media,
                               DesktopAuxService* desktop_aux, EventBus* events,
                               ToolRegistry* tools) {
  config_ = config;
  engine_ = engine;
  media_ = media;
  desktop_aux_ = desktop_aux;
  events_ = events;
  tools_ = tools;
}

bool AgentDesktopTools::handles(const std::string& name) const {
  static const char* k[] = {
      "chat_choice_card",    "media_stop",          "media_status",       "play_youtube",
      "play_local_media",    "search_local_media",  "search_local_files", "browser_navigate",
      "browser_snapshot",    "web_search",          "web_fetch",          "inference_status",
      "list_models",         "load_model",          "unload_model",
      "show_chat_media"};
  for (const char* n : k) {
    if (name == n) return true;
  }
  return false;
}

json AgentDesktopTools::run(const std::string& name,
                            const std::map<std::string, std::string>& args) {
  if (name == "chat_choice_card") {
    const std::string prompt = arg_str(args, "prompt", "Choose an option:");
    if (prompt.find("GPU mode") != std::string::npos ||
        prompt.find("Content Studio render") != std::string::npos) {
      return tool_err(
          "Content Studio GPU mode is handled by the runtime after briefing — call "
          "content_create_run with theme only (sessionId is auto-injected).");
    }
    std::string options_raw = arg_str(args, "options");
    if (options_raw.empty()) options_raw = "[]";
    json options;
    try {
      options = json::parse(options_raw);
    } catch (...) {
      return tool_err("options must be JSON array");
    }
    if (!options.is_array()) return tool_err("options must be JSON array");
    const bool allow_custom = arg_bool(args, "allow_custom", true) || arg_bool(args, "allowCustom");
    return tool_ok(choices_block(prompt, options, allow_custom));
  }

  if (name == "media_stop") {
    if (!media_) return tool_err("media player unavailable");
    const json r = media_->stop();
    return tool_ok(r.value("output", "stopped"));
  }

  if (name == "media_status") {
    if (!media_) return tool_err("media player unavailable");
    return tool_ok(media_->state().dump(2));
  }

  if (name == "play_youtube") {
    if (!media_ || !desktop_aux_ || !events_) return tool_err("media/browser unavailable");
    const std::string query = arg_str(args, "query");
    const std::string url_in = arg_str(args, "url");
    try {
      const std::string url = build_youtube_url(query, url_in);
      if (url.empty()) return tool_err("query or url required");
      const std::string video_id = extract_youtube_video_id(url);
      const bool is_search_page = url.find("/results?") != std::string::npos;
      std::string embed_url;
      if (!video_id.empty()) {
        embed_url = "https://www.youtube.com/embed/" + video_id +
                    "?autoplay=1&rel=0&modestbranding=1&hl=en&playsinline=1&enablejsapi=1";
      }
      if (video_id.empty() || is_search_page) {
        desktop_aux_->browser_navigate(url, *events_);
        media_->play_youtube_url(url, query.empty() ? "YouTube" : query, "", false);
        json part{{"type", "youtube"},
                   {"watchUrl", url},
                   {"title", query.empty() ? "YouTube" : query}};
        return tool_ok("Opened YouTube in the Browser tab — pick a video or refine your search.",
                       json::array({part}));
      }
      media_->play_youtube_url(url, query.empty() ? "YouTube" : query, embed_url, false);
      json part{{"type", "youtube"},
                {"embedUrl", embed_url},
                {"watchUrl", url},
                {"title", query.empty() ? "YouTube" : query}};
      return tool_ok("Playing on YouTube in the chat media player.", json::array({part}));
    } catch (const std::exception& e) {
      return tool_err(std::string("YouTube playback failed: ") + e.what());
    }
  }

  if (name == "search_local_media") {
    const std::string query = arg_str(args, "query");
    const std::string folder = arg_str(args, "folder");
    const bool audio_only = arg_bool(args, "audio_only");
    int limit = 20;
    if (!arg_str(args, "limit").empty()) {
      try {
        limit = std::stoi(arg_str(args, "limit"));
      } catch (...) {
      }
    }
    limit = std::max(1, std::min(100, limit));
    const json hits = search_media_files(query, folder, audio_only, limit);
    return tool_ok(hits.dump(2));
  }

  if (name == "search_local_files") {
    const std::string query = arg_str(args, "query");
    const std::string category = lower_copy(arg_str(args, "category", "any"));
    const std::string folder = arg_str(args, "folder");
    const bool wide = arg_bool(args, "wide", false);
    int limit = 40;
    if (!arg_str(args, "limit").empty()) {
      try {
        limit = std::stoi(arg_str(args, "limit"));
      } catch (...) {
      }
    }
    limit = std::max(1, std::min(200, limit));

    auto ext_matches = [&](const fs::path& path) {
      const std::string ext = lower_copy(path.extension().string());
      if (category == "any") return true;
      if (category == "audio") return is_media_ext(path, true);
      if (category == "video") {
        static const char* k[] = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"};
        for (const char* v : k) {
          if (ext == v) return true;
        }
        return false;
      }
      if (category == "media") return is_media_ext(path, false);
      if (category == "image") {
        static const char* k[] = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"};
        for (const char* v : k) {
          if (ext == v) return true;
        }
        return false;
      }
      if (category == "code") {
        static const char* k[] = {".ts",  ".tsx", ".js",  ".jsx", ".py",  ".cpp", ".c",
                                  ".h",   ".hpp", ".cs",  ".go",  ".rs",  ".java", ".json",
                                  ".yaml", ".yml", ".md",  ".html", ".css", ".vue", ".mjs"};
        for (const char* v : k) {
          if (ext == v) return true;
        }
        return false;
      }
      if (category == "document") {
        static const char* k[] = {".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".xlsx", ".pptx"};
        for (const char* v : k) {
          if (ext == v) return true;
        }
        return false;
      }
      return true;
    };

    std::vector<fs::path> roots;
    if (!folder.empty() && fs::exists(folder)) {
      roots.push_back(fs::path(folder));
    } else if (category == "code") {
      roots.push_back(fs::current_path());
      const fs::path home = fs::path(omega_home());
      if (fs::exists(home / "projects")) roots.push_back(home / "projects");
    } else if (category == "document") {
#ifdef _WIN32
      const char* profile = std::getenv("USERPROFILE");
      if (profile && *profile) {
        const fs::path home = profile;
        roots.push_back(home / "Documents");
        roots.push_back(home / "Downloads");
      }
#else
      const char* home_env = std::getenv("HOME");
      if (home_env && *home_env) {
        const fs::path home = home_env;
        roots.push_back(home / "Documents");
        roots.push_back(home / "Downloads");
      }
#endif
    } else {
      roots = default_media_roots();
    }

    json hits = json::array();
    for (const auto& root : roots) {
      if (!fs::exists(root)) continue;
      std::error_code ec;
      const auto scan = [&](const fs::path& base, bool recursive) {
        if (recursive) {
          for (fs::recursive_directory_iterator it(base, ec), end;
               it != end && hits.size() < static_cast<size_t>(limit); it.increment(ec)) {
            if (ec || !it->is_regular_file(ec)) continue;
            if (!ext_matches(it->path())) continue;
            if (!query.empty() && !filename_matches_query(it->path().filename().string(), query)) {
              continue;
            }
            hits.push_back(json{{"path", fs::absolute(it->path()).string()},
                                {"name", it->path().filename().string()},
                                {"category", category},
                                {"root", root.string()}});
          }
        } else {
          for (const auto& entry : fs::directory_iterator(base, ec)) {
            if (ec || !entry.is_regular_file(ec)) continue;
            if (!ext_matches(entry.path())) continue;
            if (!query.empty() &&
                !filename_matches_query(entry.path().filename().string(), query)) {
              continue;
            }
            hits.push_back(json{{"path", fs::absolute(entry.path()).string()},
                                {"name", entry.path().filename().string()},
                                {"category", category},
                                {"root", root.string()}});
            if (hits.size() >= static_cast<size_t>(limit)) break;
          }
        }
      };
      scan(root, wide || category == "code");
      if (hits.size() >= static_cast<size_t>(limit)) break;
    }
    return tool_ok(hits.dump(2));
  }

  if (name == "play_local_media") {
    if (!media_) return tool_err("media player unavailable");
    std::string path = arg_str(args, "path");
    const std::string query = arg_str(args, "query");
    if (path.empty() && !query.empty()) {
      const json hits = search_media_files(query, "", false, 1);
      if (hits.is_array() && !hits.empty()) path = hits[0].value("path", "");
    }
    if (path.empty() || !fs::exists(path)) {
      return tool_err("No matching local media file — try search_local_media first.");
    }
    const std::string title = fs::path(path).filename().string();
    media_->play_local_path(fs::absolute(path).string(), title);
    return tool_ok("Playing local file: " + title);
  }

  if (name == "browser_navigate") {
    if (!desktop_aux_ || !events_) return tool_err("browser unavailable");
    const std::string url = arg_str(args, "url");
    if (url.empty()) return tool_err("url required");
    const json r = desktop_aux_->browser_navigate(url, *events_);
    return tool_ok(r.dump(2));
  }

  if (name == "browser_snapshot") {
    if (!desktop_aux_) return tool_err("browser unavailable");
    return tool_ok(desktop_aux_->browser_status().dump(2));
  }

  if (name == "web_search") {
    const std::string query = arg_str(args, "query");
    if (query.empty()) return tool_err("query required");
    try {
      https::RequestOptions opts = desktop_http_opts();
      opts.read_timeout_sec = 15;
      const https::HttpResponse res = https::get(
          "https://api.duckduckgo.com/?q=" + url_encode(query) + "&format=json&no_html=1", opts);
      if (res.status >= 400) return tool_err("web search failed");
      const json body = json::parse(res.body);
      std::ostringstream out;
      if (body.contains("AbstractText") && body["AbstractText"].is_string()) {
        out << body["AbstractText"].get<std::string>() << '\n';
      }
      if (body.contains("RelatedTopics") && body["RelatedTopics"].is_array()) {
        int n = 0;
        for (const auto& t : body["RelatedTopics"]) {
          if (t.contains("Text") && t["Text"].is_string()) {
            out << "- " << t["Text"].get<std::string>() << '\n';
            if (++n >= 5) break;
          }
        }
      }
      const std::string text = out.str();
      return tool_ok(text.empty() ? res.body : text);
    } catch (const std::exception& e) {
      return tool_err(std::string("web search failed: ") + e.what());
    }
  }

  if (name == "web_fetch") {
    const std::string url = arg_str(args, "url");
    if (url.empty()) return tool_err("url required");
    if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0) {
      return tool_err("url must start with http:// or https://");
    }
    try {
      https::RequestOptions opts = desktop_http_opts();
      opts.read_timeout_sec = 20;
      const https::HttpResponse res = https::get(url, opts);
      if (res.status >= 400) return tool_err("HTTP " + std::to_string(res.status));
      std::string body = res.body;
      const int max_chars = 12000;
      if (static_cast<int>(body.size()) > max_chars) {
        body = body.substr(0, max_chars) + "\n…(truncated)";
      }
      return tool_ok(body);
    } catch (const std::exception& e) {
      return tool_err(std::string("fetch failed: ") + e.what());
    }
  }

  if (!engine_) return tool_err("engine unavailable");

  if (name == "inference_status") {
    try {
      engine_->ensure_started();
      json payload{{"engine_running", true}};
      const json loaded = engine_->command("model.loaded", json::object(), 10000);
      payload["loaded"] = loaded;
      if (config_) payload["defaultModel"] = config_->load().value("defaultModel", "");
      return tool_ok(payload.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "list_models") {
    try {
      engine_->ensure_started();
      const json models = engine_->command("model.list", json::object(), 30000);
      return tool_ok(models.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "load_model") {
    const std::string model_id = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (model_id.empty()) return tool_err("modelId required");
    try {
      engine_->ensure_started();
      json body{{"modelId", model_id}};
      if (arg_bool(args, "forceLoad")) body["forceLoad"] = true;
      const json r = engine_->command("model.load", body, 600000);
      return tool_ok(r.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "unload_model") {
    const std::string model_id = arg_str(args, "modelId", arg_str(args, "model_id"));
    if (model_id.empty()) {
      return tool_err("modelId required — refusing to unload every model without an explicit id");
    }
    try {
      engine_->ensure_started();
      json body{{"modelId", model_id}};
      const json r = engine_->command("model.unload", body, 120000);
      return tool_ok(r.dump(2));
    } catch (const std::exception& e) {
      return tool_err(e.what());
    }
  }

  if (name == "show_chat_media") {
    if (!desktop_aux_) return tool_err("desktop shell unavailable");
    json body = json::object();
    const std::string session_id = arg_str(args, "sessionId", arg_str(args, "session_id"));
    if (!session_id.empty()) body["sessionId"] = session_id;
    const std::string job_id = arg_str(args, "jobId", arg_str(args, "job_id"));
    if (!job_id.empty()) body["jobId"] = job_id;
    return tool_ok(desktop_aux_->reopen_session_video(body).dump(2));
  }

  return tool_err("desktop tool not implemented: " + name);
}

}  // namespace omega::runtime
