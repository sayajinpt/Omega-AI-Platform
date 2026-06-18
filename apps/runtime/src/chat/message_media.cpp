#include "omega/runtime/chat/message_media.hpp"

#include "omega/runtime/chat/attachment_extract.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/storage/session_store.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr size_t kMaxInlineTextBytes = 48 * 1024;

bool is_text_extension(const std::string& ext) {
  static const char* k[] = {".txt",  ".md",   ".json", ".xml",  ".html", ".htm",  ".csv",
                            ".ts",   ".tsx",  ".js",   ".jsx",  ".py",   ".cpp",  ".c",
                            ".h",    ".hpp",  ".cs",   ".java", ".go",   ".rs",   ".rb",
                            ".php",  ".sql",  ".yaml", ".yml",  ".toml", ".ini",  ".cfg",
                            ".log",  ".sh",   ".bat",  ".ps1",  ".css",  ".scss", ".vue",
                            ".svelte"};
  for (const char* e : k) {
    if (ext == e) return true;
  }
  return false;
}

bool is_text_mime(const std::string& mime) {
  return mime.rfind("text/", 0) == 0 || mime == "application/json" || mime == "application/xml" ||
         mime == "application/javascript";
}

std::string read_text_limited(const fs::path& path, size_t max_bytes, bool& truncated) {
  truncated = false;
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  std::string buf(max_bytes, '\0');
  in.read(buf.data(), static_cast<std::streamsize>(max_bytes));
  const auto got = static_cast<size_t>(in.gcount());
  buf.resize(got);
  if (in.peek() != std::ifstream::traits_type::eof()) truncated = true;
  return buf;
}

fs::path resolve_ref_path(const std::string& session_root, const std::string& ref,
                          const json& attachment) {
  if (!attachment.is_null() && attachment.is_object()) {
    const std::string path = attachment.value("path", "");
    if (!path.empty() && fs::exists(path)) return fs::path(path);
  }
  if (ref.empty()) return {};
  const fs::path direct = fs::path(session_root) / "media" / ref;
  if (fs::exists(direct)) return direct;
  const fs::path rel = fs::path(session_root) / ref;
  if (fs::exists(rel)) return rel;
  return {};
}

json find_attachment(const json& attachments, const std::string& ref) {
  if (!attachments.is_array()) return json();
  for (const auto& a : attachments) {
    if (!a.is_object()) continue;
    if (a.value("id", "") == ref) return a;
  }
  return json();
}

void append_unique_image_path(json& msg, const std::string& path) {
  if (!msg.contains("imagePaths") || !msg["imagePaths"].is_array()) msg["imagePaths"] = json::array();
  for (const auto& existing : msg["imagePaths"]) {
    if (existing.is_string() && existing.get<std::string>() == path) return;
  }
  msg["imagePaths"].push_back(path);
}

}  // namespace

std::string normalize_session_media_ref(const std::string& ref) {
  if (ref.empty()) return ref;
  if (ref.rfind("media/", 0) == 0) return ref.substr(6);
  if (ref.rfind("media\\", 0) == 0) return ref.substr(6);
  return ref;
}

bool is_session_media_ref_safe(const std::string& ref) {
  const std::string normalized = normalize_session_media_ref(ref);
  if (normalized.empty()) return false;
  if (normalized.find("..") != std::string::npos) return false;
  if (normalized.find('/') != std::string::npos || normalized.find('\\') != std::string::npos) {
    return false;
  }
  return true;
}

std::string resolve_session_media_path(const std::string& session_id, const std::string& ref,
                                       ProjectStore& projects) {
  if (session_id.empty() || ref.empty()) return "";
  if (!is_session_media_ref_safe(ref)) return "";
  try {
    const std::string root = projects.ensure_dir(session_id);
    const std::string normalized = normalize_session_media_ref(ref);
    const fs::path p = resolve_ref_path(root, normalized, json());
    return p.empty() ? "" : p.string();
  } catch (...) {
    return "";
  }
}

namespace {

bool video_part_exists(ProjectStore& projects, const std::string& session_id,
                       const json& part) {
  if (!part.is_object() || part.value("type", "") != "video") return false;
  const std::string ref = part.value("ref", "");
  return !ref.empty() && !resolve_session_media_path(session_id, ref, projects).empty();
}

std::optional<json> video_part_from_ref(const std::string& ref) {
  if (ref.empty()) return std::nullopt;
  return json{{"type", "video"}, {"ref", ref}};
}

std::string find_project_id_for_job(SessionStore& sessions, const std::string& session_id,
                                    const std::string& job_id) {
  if (session_id.empty() || job_id.empty()) return "";
  const json messages = sessions.get_messages(session_id);
  if (!messages.is_array()) return "";
  for (auto it = messages.rbegin(); it != messages.rend(); ++it) {
    if (it->value("role", "") != "assistant") continue;
    const json parts = it->value("parts", json::array());
    if (!parts.is_array()) continue;
    for (const auto& p : parts) {
      if (!p.is_object()) continue;
      if (p.value("type", "") == "content_studio" && p.value("jobId", "") == job_id) {
        return p.value("projectId", "");
      }
    }
  }
  return "";
}

std::string hash_file_prefix(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::string data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const size_t h = std::hash<std::string>{}(data);
  std::ostringstream ss;
  ss << std::hex << (h & 0xFFFFFFFFFFFFFULL);
  return ss.str().substr(0, 16);
}

std::optional<json> import_content_studio_mp4(ProjectStore& projects,
                                              const std::string& session_id,
                                              const std::string& project_id,
                                              const std::string& job_id) {
  if (session_id.empty() || project_id.empty() || job_id.empty()) return std::nullopt;
  const fs::path src =
      fs::path(resolve_content_studio_storage()) / project_id / job_id / "final.mp4";
  if (!fs::exists(src)) return std::nullopt;

  projects.ensure_dir(session_id);
  const fs::path media_dir = fs::path(projects.open_folder(session_id)) / "media";
  fs::create_directories(media_dir);
  const std::string id = hash_file_prefix(src) + ".mp4";
  const fs::path dest = media_dir / id;
  fs::copy_file(src, dest, fs::copy_options::overwrite_existing);
  return json{{"type", "video"}, {"ref", id}};
}

}  // namespace

std::optional<json> find_session_video_part(SessionStore& sessions, ProjectStore& projects,
                                            const std::string& session_id,
                                            const std::string& job_id) {
  if (session_id.empty()) return std::nullopt;
  const json messages = sessions.get_messages(session_id);
  if (!messages.is_array()) return std::nullopt;

  for (auto it = messages.rbegin(); it != messages.rend(); ++it) {
    if (it->value("role", "") != "assistant") continue;
    const json parts = it->value("parts", json::array());
    if (!parts.is_array()) continue;

    if (!job_id.empty()) {
      std::string video_ref;
      for (const auto& p : parts) {
        if (!p.is_object()) continue;
        if (p.value("type", "") == "content_studio" && p.value("jobId", "") == job_id) {
          if (p.contains("videoRef") && p["videoRef"].is_string()) {
            video_ref = p["videoRef"].get<std::string>();
          }
          break;
        }
      }
      if (!video_ref.empty()) {
        if (const auto part = video_part_from_ref(video_ref)) {
          if (video_part_exists(projects, session_id, *part)) return part;
        }
      }
    }

    for (const auto& p : parts) {
      if (video_part_exists(projects, session_id, p)) return p;
    }
  }
  return std::nullopt;
}

json reopen_session_video(SessionStore& sessions, ProjectStore& projects,
                          MediaPlayerService& media, const json& body) {
  const std::string session_id = body.value("sessionId", body.value("session_id", ""));
  const std::string job_id = body.value("jobId", body.value("job_id", ""));
  if (session_id.empty()) {
    return json{{"ok", false}, {"message", "sessionId required"}};
  }

  std::optional<json> part = find_session_video_part(sessions, projects, session_id, job_id);
  if (!part && !job_id.empty()) {
    const std::string project_id = find_project_id_for_job(sessions, session_id, job_id);
    if (!project_id.empty()) {
      part = import_content_studio_mp4(projects, session_id, project_id, job_id);
    }
  }
  if (!part) {
    return json{{"ok", false},
                {"message", job_id.empty() ? "No video found in this chat session"
                                           : "No video found for this Content Studio job yet"}};
  }

  media.show_preview(json{{"sessionId", session_id}, {"part", *part}});
  return json{{"ok", true}, {"message", "Video opened in chat"}, {"ref", part->value("ref", "")}};
}

json user_message_persist_extras(const json& user_message) {
  json extras = json::object();
  if (user_message.contains("parts") && user_message["parts"].is_array() &&
      !user_message["parts"].empty()) {
    extras["parts"] = user_message["parts"];
  }
  if (user_message.contains("attachments") && user_message["attachments"].is_array() &&
      !user_message["attachments"].empty()) {
    extras["attachments"] = user_message["attachments"];
  }
  return extras.empty() ? json() : extras;
}

std::string format_attachment_context_for_prompt(const json& messages,
                                                 const std::string& session_id,
                                                 ProjectStore& projects) {
  if (session_id.empty() || !messages.is_array() || messages.empty()) return "";
  json last_user;
  for (auto it = messages.rbegin(); it != messages.rend(); ++it) {
    if (it->value("role", "") == "user") {
      last_user = *it;
      break;
    }
  }
  if (last_user.is_null()) return "";

  std::ostringstream oss;
  bool any = false;
  const std::string root = projects.ensure_dir(session_id);

  auto describe = [&](const std::string& kind, const std::string& name, const std::string& mime,
                      const std::string& note) {
    if (!any) {
      oss << "USER_ATTACHMENTS (staged for this turn):\n";
      any = true;
    }
    oss << "- " << kind << ": " << name;
    if (!mime.empty()) oss << " (" << mime << ")";
    if (!note.empty()) oss << " — " << note;
    oss << "\n";
  };

  const json attachments = last_user.value("attachments", json::array());
  if (last_user.contains("parts") && last_user["parts"].is_array()) {
    for (const auto& p : last_user["parts"]) {
      if (!p.is_object()) continue;
      const std::string type = p.value("type", "");
      if (type == "text") continue;
      const std::string ref = p.value("ref", "");
      const json att = find_attachment(attachments, ref);
      const std::string name = p.value("name", att.value("name", ref));
      const std::string mime = att.value("mime", "");
      if (type == "image") {
        describe("image", name, mime, "available to vision models via imagePaths");
      } else if (type == "file") {
        const fs::path path = resolve_ref_path(root, ref, att);
        const std::string ext = path.extension().string();
        if (ext == ".pdf" || mime == "application/pdf") {
          describe("pdf", name, mime,
                   "text extracted with pdftotext when available, inlined in USER_INPUT");
        } else if (!path.empty() &&
                   (is_text_mime(mime) || is_text_extension(ext))) {
          describe("file", name, mime, "full text inlined in USER_INPUT / message content");
        } else {
          describe("file", name, mime, "binary or non-inlined; use read_file if you need contents");
        }
      } else if (type == "audio") {
        describe("audio", name, mime,
                 "transcript inlined in USER_INPUT when Ollama STT is available");
      } else if (type == "video") {
        describe("video", name, mime, "not decoded frame-by-frame; describe or use tools if added");
      }
    }
  }

  if (!any && attachments.is_array()) {
    for (const auto& a : attachments) {
      if (!a.is_object()) continue;
      describe(a.value("kind", "file"), a.value("name", a.value("id", "attachment")),
               a.value("mime", ""), "staged in session media folder");
    }
  }

  return oss.str();
}

json prepare_chat_messages_for_inference(const json& messages, const std::string& session_id,
                                         ProjectStore& projects, const json& top_attachments,
                                         const json& config) {
  if (!messages.is_array()) return messages;

  json out = messages;
  if (session_id.empty()) return out;

  std::string root;
  try {
    root = projects.ensure_dir(session_id);
  } catch (...) {
    return out;
  }

  int last_user_idx = -1;
  for (size_t i = 0; i < out.size(); ++i) {
    if (out[i].value("role", "") == "user") last_user_idx = static_cast<int>(i);
  }

  if (last_user_idx >= 0 && top_attachments.is_array() && !top_attachments.empty()) {
    json& u = out[static_cast<size_t>(last_user_idx)];
    if (!u.contains("attachments") || !u["attachments"].is_array()) u["attachments"] = json::array();
    for (const auto& a : top_attachments) {
      if (!a.is_object()) continue;
      bool dup = false;
      for (const auto& ex : u["attachments"]) {
        if (ex.value("id", "") == a.value("id", "")) dup = true;
      }
      if (!dup) u["attachments"].push_back(a);
    }
    if (!u.contains("parts") || !u["parts"].is_array()) u["parts"] = json::array();
    for (const auto& a : top_attachments) {
      if (!a.is_object()) continue;
      const std::string kind = a.value("kind", "file");
      const std::string id = a.value("id", "");
      if (id.empty()) continue;
      bool has = false;
      for (const auto& p : u["parts"]) {
        if (p.is_object() && p.value("ref", "") == id) has = true;
      }
      if (has) continue;
      if (kind == "image") {
        u["parts"].push_back(
            json{{"type", "image"}, {"ref", id}, {"alt", a.value("name", id)}});
      } else if (kind == "audio") {
        u["parts"].push_back(json{{"type", "audio"}, {"ref", id}});
      } else if (kind == "video") {
        u["parts"].push_back(json{{"type", "video"}, {"ref", id}});
      } else {
        u["parts"].push_back(json{{"type", "file"},
                                  {"ref", id},
                                  {"name", a.value("name", id)},
                                  {"mime", a.value("mime", "")},
                                  {"sizeBytes", a.value("sizeBytes", 0)}});
      }
    }
  }

  for (auto& msg : out) {
    if (msg.value("role", "") != "user") continue;
    const json attachments = msg.value("attachments", json::array());
    std::string extra_inline;

    if (!msg.contains("parts") || !msg["parts"].is_array()) continue;

    for (const auto& p : msg["parts"]) {
      if (!p.is_object()) continue;
      const std::string type = p.value("type", "");
      const std::string ref = p.value("ref", "");
      const json att = find_attachment(attachments, ref);
      const fs::path path = resolve_ref_path(root, ref, att);
      if (path.empty()) continue;

      if (type == "image") {
        append_unique_image_path(msg, path.string());
        continue;
      }

      if (type == "file") {
        const std::string mime = att.value("mime", p.value("mime", ""));
        const std::string ext = path.extension().string();
        const std::string name = p.value("name", path.filename().string());

        if (ext == ".pdf" || mime == "application/pdf") {
          std::string pdf_text = extract_pdf_text(path.string());
          bool truncated = false;
          if (pdf_text.size() > kMaxInlineTextBytes) {
            truncated = true;
            pdf_text.resize(kMaxInlineTextBytes);
          }
          if (!pdf_text.empty()) {
            extra_inline += "\n\n```pdf file=\"" + name + "\"\n" + pdf_text;
            if (truncated) extra_inline += "\n…(truncated)…";
            extra_inline += "\n```\n";
          }
          continue;
        }

        if (!is_text_mime(mime) && !is_text_extension(ext)) continue;

        bool truncated = false;
        const std::string text = read_text_limited(path, kMaxInlineTextBytes, truncated);
        if (text.empty()) continue;
        extra_inline += "\n\n```" + ext.substr(1) + " file=\"" + name + "\"\n" + text;
        if (truncated) extra_inline += "\n…(truncated)…";
        extra_inline += "\n```\n";
      } else if (type == "audio") {
        if (const auto transcript = transcribe_audio_attachment(path.string(), config)) {
          const std::string name = p.value("name", path.filename().string());
          extra_inline += "\n\n[Audio transcript: " + name + "]\n" + *transcript + "\n";
        }
      }
    }

    if (!extra_inline.empty()) {
      std::string content = msg.value("content", "");
      content += extra_inline;
      msg["content"] = content;
    }
  }

  return out;
}

}  // namespace omega::runtime
