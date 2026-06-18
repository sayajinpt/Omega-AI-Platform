#include "omega/runtime/chat/media_encode.hpp"

#include <filesystem>
#include <fstream>
#include <httplib.h>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string read_file_bytes(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return "";
  return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

}  // namespace

std::string read_file_base64(const std::string& path) {
  const std::string bytes = read_file_bytes(path);
  if (bytes.empty()) return "";
  return httplib::detail::base64_encode(bytes);
}

std::string image_mime_from_path(const std::string& path) {
  const std::string ext = fs::path(path).extension().string();
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".gif") return "image/gif";
  if (ext == ".webp") return "image/webp";
  if (ext == ".bmp") return "image/bmp";
  return "image/jpeg";
}

bool messages_have_image_paths(const json& messages) {
  if (!messages.is_array()) return false;
  for (const auto& m : messages) {
    if (!m.is_object()) continue;
    if (m.contains("imagePaths") && m["imagePaths"].is_array() && !m["imagePaths"].empty()) {
      return true;
    }
  }
  return false;
}

json encode_messages_for_ollama(const json& messages) {
  if (!messages.is_array()) return messages;
  json out = json::array();
  for (const auto& m : messages) {
    if (!m.is_object()) {
      out.push_back(m);
      continue;
    }
    json copy = m;
    copy.erase("imagePaths");
    if (m.contains("imagePaths") && m["imagePaths"].is_array()) {
      json images = json::array();
      for (const auto& p : m["imagePaths"]) {
        if (!p.is_string()) continue;
        const std::string b64 = read_file_base64(p.get<std::string>());
        if (!b64.empty()) images.push_back(b64);
      }
      if (!images.empty()) copy["images"] = images;
    }
    out.push_back(copy);
  }
  return out;
}

json encode_messages_for_openai_vision(const json& messages) {
  if (!messages.is_array()) return messages;
  json out = json::array();
  for (const auto& m : messages) {
    if (!m.is_object()) {
      out.push_back(m);
      continue;
    }
    json copy = m;
    if (!m.contains("imagePaths") || !m["imagePaths"].is_array() || m["imagePaths"].empty()) {
      copy.erase("imagePaths");
      out.push_back(copy);
      continue;
    }

    json parts = json::array();
    const std::string text = m.value("content", "");
    if (!text.empty()) parts.push_back(json{{"type", "text"}, {"text", text}});

    for (const auto& p : m["imagePaths"]) {
      if (!p.is_string()) continue;
      const std::string path = p.get<std::string>();
      const std::string b64 = read_file_base64(path);
      if (b64.empty()) continue;
      const std::string mime = image_mime_from_path(path);
      parts.push_back(json{{"type", "image_url"},
                           {"image_url", {{"url", "data:" + mime + ";base64," + b64}}}});
    }

    copy.erase("imagePaths");
    if (!parts.empty()) {
      copy["content"] = parts;
    }
    out.push_back(copy);
  }
  return out;
}

}  // namespace omega::runtime
