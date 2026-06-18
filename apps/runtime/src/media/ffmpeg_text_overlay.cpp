#include "omega/runtime/media/ffmpeg_text_overlay.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime::ffmpeg_media {

namespace {

std::string escape_drawtext(std::string text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (char c : text) {
    if (c == '\\') out += "\\\\";
    else if (c == ':') out += "\\:";
    else if (c == '\'') out += "\\'";
    else if (c == '%') out += "\\%";
    else if (c == ',') out += "\\,";
    else if (c == '\r' || c == '\n') out.push_back(' ');
    else out.push_back(c);
  }
  while (!out.empty() && out.front() == ' ') out.erase(out.begin());
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

std::string first_sentence(const std::string& narr) {
  size_t end = narr.size();
  for (size_t i = 0; i + 1 < narr.size(); ++i) {
    const char c = narr[i];
    if ((c == '.' || c == '!' || c == '?') && narr[i + 1] == ' ') {
      end = i + 1;
      break;
    }
  }
  return narr.substr(0, end);
}

}  // namespace

std::optional<fs::path> resolve_system_font_path() {
#ifdef _WIN32
  if (const char* windir = std::getenv("WINDIR")) {
    const fs::path fonts = fs::path(windir) / "Fonts";
    const char* names[] = {"segoeuib.ttf", "SegoeUIBold.ttf", "arialbd.ttf", "arial.ttf"};
    for (const char* name : names) {
      const fs::path p = fonts / name;
      if (fs::exists(p)) return p;
    }
  }
#endif
  const char* candidates[] = {
      "C:/Windows/Fonts/segoeuib.ttf",
      "C:/Windows/Fonts/arialbd.ttf",
      "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  };
  for (const char* raw : candidates) {
    const fs::path p(raw);
    if (fs::exists(p)) return p;
  }
  return std::nullopt;
}

std::string overlay_caption_for_scene(const json& scene) {
  std::vector<std::string> parts;
  if (scene.contains("text_overlays") && scene["text_overlays"].is_array()) {
    for (const auto& item : scene["text_overlays"]) {
      std::string t;
      if (item.is_object()) t = item.value("text", "");
      else if (item.is_string()) t = item.get<std::string>();
      if (!t.empty()) parts.push_back(t);
    }
  }
  if (!parts.empty()) {
    std::ostringstream joined;
    for (size_t i = 0; i < parts.size(); ++i) {
      if (i) joined << " · ";
      joined << parts[i];
    }
    std::string out = joined.str();
    if (out.size() > 140) out.resize(140);
    return out;
  }

  const std::string narr = scene.value("narration_text", scene.value("narrationText", ""));
  if (narr.empty()) return {};
  std::string sentence = first_sentence(narr);
  std::istringstream iss(sentence);
  std::string word;
  std::ostringstream short_line;
  int count = 0;
  while (iss >> word && count < 10) {
    if (count++) short_line << ' ';
    short_line << word;
    ++count;
  }
  std::string out = short_line.str();
  if (out.size() > 120) out.resize(120);
  return out;
}

std::string write_caption_textfile(const fs::path& segments_dir, const int scene_number,
                                   const std::string& caption) {
  std::string text = caption;
  for (char& c : text) {
    if (c == '\r' || c == '\n') c = ' ';
  }
  while (!text.empty() && text.front() == ' ') text.erase(text.begin());
  while (!text.empty() && text.back() == ' ') text.pop_back();
  if (text.empty()) return {};

  char name_buf[32];
  std::snprintf(name_buf, sizeof(name_buf), "caption_%02d.txt", scene_number);
  const fs::path out = segments_dir / name_buf;
  std::ofstream file(out, std::ios::binary);
  if (!file) return {};
  file << text;
  return name_buf;
}

std::string video_filter_with_caption(const std::string& base_vf, const std::string& caption,
                                      int width, int height, const std::string& fontfile,
                                      const std::string& textfile) {
  if (fontfile.empty()) return base_vf;
  const std::string text = escape_drawtext(caption);
  if (textfile.empty() && text.empty()) return base_vf;

  const int size = std::max(28, std::min(56, height / 18));
  const int border = std::max(2, size / 14);

  std::ostringstream dt;
  dt << "drawtext=fontfile=" << fontfile << ":";
  if (!textfile.empty()) {
    dt << "textfile=" << textfile;
  } else {
    dt << "text='" << text << "'";
  }
  dt << ":fontsize=" << size << ":fontcolor=white:borderw=" << border
     << ":bordercolor=black@0.9:"
     << "x=(w-text_w)/2:y=h-h/5-text_h";
  (void)width;
  return base_vf + "," + dt.str();
}

}  // namespace omega::runtime::ffmpeg_media
