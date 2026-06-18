#include "omega/runtime/services/chat_attachment_service.hpp"

#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <commdlg.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

const std::unordered_set<std::string> k_image_ext{".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
                                                  ".svg"};
const std::unordered_set<std::string> k_allowed_ext{
    ".png",  ".jpg",  ".jpeg", ".gif",  ".webp", ".pdf",  ".txt",  ".md",   ".csv",
    ".json", ".xml",  ".html", ".htm",  ".wav",  ".mp3",  ".m4a",  ".ogg",  ".webm",
    ".mp4"};

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

#ifdef _WIN32
std::string narrow_utf8(const std::wstring& ws) {
  if (ws.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, out.data(), n, nullptr, nullptr);
  return out;
}

std::vector<std::string> win_pick_attachment_paths() {
  std::vector<std::string> out;
  std::vector<wchar_t> file_buf(65536, L'\0');
  OPENFILENAMEW ofn{};
  ofn.lStructSize = sizeof(ofn);
  ofn.lpstrFilter =
      L"Supported files\0"
      L"*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.pdf;*.txt;*.md;*.csv;*.json;*.wav;*.mp3;*.m4a;*.ogg;*.webm;*.mp4\0"
      L"Images\0*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp\0"
      L"All files\0*.*\0";
  ofn.lpstrFile = file_buf.data();
  ofn.nMaxFile = static_cast<DWORD>(file_buf.size());
  ofn.Flags = OFN_EXPLORER | OFN_ALLOWMULTISELECT | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST |
              OFN_NOCHANGEDIR;
  if (!GetOpenFileNameW(&ofn)) return out;

  const wchar_t* buffer = file_buf.data();
  const wchar_t* leaf = buffer + ofn.nFileOffset;
  if (*leaf == L'\0') {
    const std::string path = narrow_utf8(buffer);
    if (!path.empty() && k_allowed_ext.count(fs::path(path).extension().string()) > 0) {
      out.push_back(path);
    }
    return out;
  }

  const std::wstring dir(buffer);
  while (*leaf) {
    const std::wstring full = (fs::path(dir) / leaf).wstring();
    const std::string path = narrow_utf8(full);
    if (!path.empty() && k_allowed_ext.count(fs::path(path).extension().string()) > 0) {
      out.push_back(path);
    }
    leaf += wcslen(leaf) + 1;
  }
  return out;
}
#endif

}  // namespace

ChatAttachmentService::ChatAttachmentService(ConfigStore& config, ProjectStore& projects)
    : config_(config), projects_(projects) {}

json ChatAttachmentService::limits() const {
  const json cfg = config_.load();
  const json chat = cfg.value("chat", json::object());
  const int max_mb = chat.value("maxAttachmentMb", 25);
  const int max_count = chat.value("maxAttachments", 8);
  return json{{"maxBytes", max_mb * 1024 * 1024}, {"maxCount", max_count}};
}

json ChatAttachmentService::pick_paths(const json& body) {
  if (body.is_object() && body.contains("paths") && body["paths"].is_array()) {
    json filtered = json::array();
    for (const auto& p : body["paths"]) {
      if (!p.is_string()) continue;
      const std::string path = p.get<std::string>();
      if (is_allowed_ext(fs::path(path).extension().string())) filtered.push_back(path);
    }
    return json{{"paths", filtered}};
  }

#ifdef _WIN32
  json picked = json::array();
  for (const auto& path : win_pick_attachment_paths()) picked.push_back(path);
  return json{{"paths", picked}};
#else
  return json{{"paths", json::array()}};
#endif
}

bool ChatAttachmentService::is_allowed_ext(const std::string& ext) {
  return k_allowed_ext.count(ext) > 0;
}

std::string ChatAttachmentService::mime_for(const std::string& ext) {
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".gif") return "image/gif";
  if (ext == ".webp") return "image/webp";
  if (ext == ".pdf") return "application/pdf";
  if (ext == ".txt") return "text/plain";
  if (ext == ".md") return "text/markdown";
  if (ext == ".csv") return "text/csv";
  if (ext == ".json") return "application/json";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".mp3") return "audio/mpeg";
  if (ext == ".m4a") return "audio/mp4";
  if (ext == ".ogg") return "audio/ogg";
  if (ext == ".webm") return "video/webm";
  if (ext == ".mp4") return "video/mp4";
  return "application/octet-stream";
}

std::string ChatAttachmentService::kind_for(const std::string& mime, const std::string& ext) {
  if (mime.rfind("image/", 0) == 0 || k_image_ext.count(ext) > 0) return "image";
  if (mime.rfind("audio/", 0) == 0) return "audio";
  if (mime.rfind("video/", 0) == 0) return "video";
  return "file";
}

std::string ChatAttachmentService::content_hash_hex(const std::string& data) {
  const size_t h = std::hash<std::string>{}(data);
  std::ostringstream ss;
  ss << std::hex << std::setw(16) << std::setfill('0') << (h & 0xFFFFFFFFFFFFFULL);
  return ss.str().substr(0, 16);
}

json ChatAttachmentService::stage_bytes(const std::string& session_id, const std::string& name,
                                        const std::string& data, const std::string& mime_hint) {
  if (session_id.empty()) throw std::runtime_error("sessionId required");
  if (data.empty()) throw std::runtime_error("attachment data is empty");

  const auto lim = limits();
  const int64_t max_bytes = lim.value("maxBytes", 25 * 1024 * 1024);
  if (static_cast<int64_t>(data.size()) > max_bytes) {
    throw std::runtime_error("file too large (max " + std::to_string(max_bytes / (1024 * 1024)) +
                             " MB)");
  }

  fs::path src_name(name.empty() ? "attachment.bin" : name);
  std::string ext = src_name.extension().string();
  if (ext.empty()) ext = ".bin";
  if (!is_allowed_ext(ext)) throw std::runtime_error("file type not allowed: " + ext);

  projects_.ensure_dir(session_id);
  const fs::path media_dir = fs::path(projects_.open_folder(session_id)) / "media";
  fs::create_directories(media_dir);

  const std::string sha = content_hash_hex(data);
  const std::string id = sha + ext;
  const fs::path dest = media_dir / id;
  {
    std::ofstream out(dest, std::ios::binary);
    if (!out) throw std::runtime_error("failed to write staged attachment");
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
  }

  const std::string mime = !mime_hint.empty() ? mime_hint : mime_for(ext);
  return json{{"id", id},
              {"kind", kind_for(mime, ext)},
              {"path", dest.string()},
              {"mime", mime},
              {"sha256", sha},
              {"name", src_name.filename().string()},
              {"sizeBytes", data.size()}};
}

json ChatAttachmentService::stage(const std::string& session_id, const std::string& source_path) {
  const fs::path src(source_path);
  const std::string ext = src.extension().string();
  if (!is_allowed_ext(ext)) {
    throw std::runtime_error("file type not allowed: " + ext);
  }
  if (!fs::exists(src)) throw std::runtime_error("file not found: " + source_path);

  const auto lim = limits();
  const int64_t max_bytes = lim.value("maxBytes", 25 * 1024 * 1024);
  const auto size = fs::file_size(src);
  if (static_cast<int64_t>(size) > max_bytes) {
    throw std::runtime_error("file too large (max " + std::to_string(max_bytes / (1024 * 1024)) +
                             " MB)");
  }

  std::ifstream in(src, std::ios::binary);
  const std::string buf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  return stage_bytes(session_id, src.filename().string(), buf, mime_for(ext));
}

json ChatAttachmentService::stage_encoded(const std::string& session_id, const std::string& name,
                                          const std::string& data_base64,
                                          const std::string& mime_hint) {
  std::string decoded;
  if (!decode_base64(data_base64, decoded)) {
    throw std::runtime_error("invalid base64 attachment data");
  }
  return stage_bytes(session_id, name, decoded, mime_hint);
}

}  // namespace omega::runtime
