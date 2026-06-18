#include "omega/runtime/media/ffmpeg_compose.hpp"

#include "omega/runtime/media/ffmpeg_text_overlay.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime::ffmpeg_media {

namespace {

int run_cmd(const std::string& cmd) {
  return std::system(cmd.c_str());
}

std::string quote(const fs::path& p) {
  const std::string s = p.string();
  if (s.find(' ') == std::string::npos && s.find('"') == std::string::npos) return s;
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += "\"";
  return out;
}

std::pair<int, int> dims_from_aspect(const std::string& aspect) {
  if (aspect == "9:16" || aspect == "vertical") return {720, 1280};
  return {1280, 720};
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

std::string concat_line(const fs::path& p) {
  std::string text = fs::absolute(p).lexically_normal().string();
  for (char& c : text) {
    if (c == '\\') c = '/';
  }
  std::string out = "file '";
  for (char c : text) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
}

}  // namespace

std::string find_ffmpeg() {
#ifdef _WIN32
  const char* names[] = {"ffmpeg.exe", "ffmpeg"};
#else
  const char* names[] = {"ffmpeg"};
#endif
  if (const char* path = std::getenv("PATH")) {
    std::string paths = path;
    size_t start = 0;
    while (start < paths.size()) {
#ifdef _WIN32
      const char sep = ';';
#else
      const char sep = ':';
#endif
      const size_t pos = paths.find(sep, start);
      const size_t e = pos == std::string::npos ? paths.size() : pos;
      const std::string dir = paths.substr(start, e - start);
      for (const char* name : names) {
        const fs::path candidate = fs::path(dir) / name;
        if (fs::exists(candidate)) return candidate.string();
      }
      if (pos == std::string::npos) break;
      start = pos + 1;
    }
  }
  return "ffmpeg";
}

std::string find_ffprobe() {
#ifdef _WIN32
  const char* names[] = {"ffprobe.exe", "ffprobe"};
#else
  const char* names[] = {"ffprobe"};
#endif
  if (const char* path = std::getenv("PATH")) {
    std::string paths = path;
    size_t start = 0;
    while (start < paths.size()) {
#ifdef _WIN32
      const char sep = ';';
#else
      const char sep = ':';
#endif
      const size_t pos = paths.find(sep, start);
      const size_t e = pos == std::string::npos ? paths.size() : pos;
      const std::string dir = paths.substr(start, e - start);
      for (const char* name : names) {
        const fs::path candidate = fs::path(dir) / name;
        if (fs::exists(candidate)) return candidate.string();
      }
      if (pos == std::string::npos) break;
      start = pos + 1;
    }
  }
  return "ffprobe";
}

bool write_silent_wav(const fs::path& wav_path, const double duration_seconds) {
  const std::string ffmpeg = find_ffmpeg();
  if (ffmpeg.empty()) return false;
  const double dur = std::max(0.5, duration_seconds);
  fs::create_directories(wav_path.parent_path());
  std::ostringstream cmd;
  cmd << quote(fs::path(ffmpeg)) << " -y -f lavfi -i anullsrc=r=24000:cl=mono -t " << dur << " "
      << quote(wav_path) << " 2>nul";
  return run_cmd(cmd.str()) == 0 && fs::exists(wav_path);
}

int pcm16_wav_peak_abs(const fs::path& wav_path) {
  std::ifstream in(wav_path, std::ios::binary);
  if (!in) return -1;
  char header[44];
  if (!in.read(header, 44)) return -1;
  if (std::string(header, 4) != "RIFF" || std::string(header + 8, 4) != "WAVE") return -1;
  int peak = 0;
  int16_t sample = 0;
  while (in.read(reinterpret_cast<char*>(&sample), sizeof(sample))) {
    const int abs_s = sample < 0 ? -static_cast<int>(sample) : static_cast<int>(sample);
    if (abs_s > peak) peak = abs_s;
  }
  return peak;
}

int count_nearly_silent_scene_wavs(const fs::path& audio_dir,
                                   const std::vector<json>& scenes) {
  if (scenes.empty()) return 0;
  int silent = 0;
  for (size_t i = 0; i < scenes.size(); ++i) {
    const json& sc = scenes[i];
    const int sn = sc.value("scene_number", static_cast<int>(i + 1));
    char name_buf[32];
    std::snprintf(name_buf, sizeof(name_buf), "scene_%02d", sn);
    const fs::path wav = audio_dir / (std::string(name_buf) + ".wav");
    const int peak = pcm16_wav_peak_abs(wav);
    if (peak >= 0 && peak <= 8) ++silent;
  }
  return silent;
}

double probe_duration_seconds(const fs::path& media_path) {
  const std::string ffprobe = find_ffprobe();
  std::ostringstream cmd;
  cmd << quote(fs::path(ffprobe)) << " -v error -show_entries format=duration "
      << "-of default=noprint_wrappers=1:nokey=1 " << quote(media_path) << " 2>nul";
  FILE* pipe = nullptr;
#ifdef _WIN32
  pipe = _popen(cmd.str().c_str(), "r");
#else
  pipe = popen(cmd.str().c_str(), "r");
#endif
  if (!pipe) return 1.0;
  char buf[128] = {};
  if (!fgets(buf, sizeof(buf), pipe)) {
#ifdef _WIN32
    _pclose(pipe);
#else
    pclose(pipe);
#endif
    return 1.0;
  }
#ifdef _WIN32
  _pclose(pipe);
#else
  pclose(pipe);
#endif
  try {
    return std::max(0.1, std::stod(buf));
  } catch (...) {
    return 1.0;
  }
}

fs::path assemble_final_mp4(const fs::path& job_root, const json& script_content,
                            const json& brief_json, std::string& error,
                            const bool include_subtitles) {
  const std::string ffmpeg = find_ffmpeg();
  if (ffmpeg.empty()) {
    error = "ffmpeg not found on PATH";
    return {};
  }

  const auto scenes = sorted_scenes(script_content);
  if (scenes.empty()) {
    error = "no scenes in script";
    return {};
  }

  const std::string aspect = brief_json.value("aspect_ratio", "16:9");
  const auto [tw, th] = dims_from_aspect(aspect);
  const fs::path images_dir = job_root / "images";
  const fs::path audio_dir = job_root / "audio";
  const fs::path segments_dir = job_root / "segments";
  fs::create_directories(segments_dir);

  const fs::path caption_font = segments_dir / "caption_font.ttf";
  std::string fontfile_arg;
  if (const auto sys_font = resolve_system_font_path()) {
    if (!fs::exists(caption_font)) {
      std::error_code ec;
      fs::copy_file(*sys_font, caption_font, fs::copy_options::overwrite_existing, ec);
    }
    if (fs::exists(caption_font)) fontfile_arg = "caption_font.ttf";
  }

  std::vector<fs::path> segment_paths;
  for (size_t i = 0; i < scenes.size(); ++i) {
    const json& sc = scenes[i];
    const int sn = sc.value("scene_number", static_cast<int>(i + 1));
    char name_buf[32];
    std::snprintf(name_buf, sizeof(name_buf), "scene_%02d", sn);
    const fs::path img = images_dir / (std::string(name_buf) + ".png");
    const fs::path wav = audio_dir / (std::string(name_buf) + ".wav");
    if (!fs::exists(img)) {
      error = "missing image for scene " + std::to_string(sn);
      return {};
    }
    if (!fs::exists(wav)) {
      error = "missing audio for scene " + std::to_string(sn);
      return {};
    }

    const fs::path seg = segments_dir / (std::string(name_buf) + ".mp4");
    const double audio_dur = probe_duration_seconds(wav);
    std::string base_vf = "scale=" + std::to_string(tw) + ":" + std::to_string(th) +
                          ":force_original_aspect_ratio=decrease,pad=" + std::to_string(tw) + ":" +
                          std::to_string(th) +
                          ":(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a,format=yuv420p";
    if (include_subtitles) {
      const std::string caption = overlay_caption_for_scene(sc);
      const std::string caption_file =
          fontfile_arg.empty() ? std::string{} : write_caption_textfile(segments_dir, sn, caption);
      base_vf =
          video_filter_with_caption(base_vf, caption, tw, th, fontfile_arg, caption_file);
    }

    std::ostringstream cmd;
#ifdef _WIN32
    cmd << "cd /d " << quote(segments_dir) << " && ";
#else
    cmd << "cd " << quote(segments_dir) << " && ";
#endif
    cmd << quote(fs::path(ffmpeg)) << " -y -loop 1 -framerate 25 -i " << quote(img) << " -i "
        << quote(wav) << " -map 0:v:0 -map 1:a:0 -vf \"" << base_vf << "\" -c:v libx264 -preset "
        << "medium -crf 23 -c:a aac -b:a 192k -ar 48000 -ac 1 -t " << audio_dur << " -movflags "
        << "+faststart " << quote(seg) << " 2>&1";
    if (run_cmd(cmd.str()) != 0) {
      error = "ffmpeg scene encode failed for scene " + std::to_string(sn);
      return {};
    }
    segment_paths.push_back(seg);
  }

  const fs::path final_mp4 = job_root / "final.mp4";
  if (segment_paths.size() == 1) {
    std::error_code ec;
    fs::copy_file(segment_paths[0], final_mp4, fs::copy_options::overwrite_existing, ec);
    if (ec) {
      error = "failed to copy single segment: " + ec.message();
      return {};
    }
    return final_mp4;
  }

  const fs::path concat_list = segments_dir / "concat.txt";
  {
    std::ofstream out(concat_list);
    for (const auto& p : segment_paths) out << concat_line(p) << "\n";
  }

  std::ostringstream cmd;
  cmd << quote(fs::path(ffmpeg)) << " -y -f concat -safe 0 -i " << quote(concat_list)
      << " -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags "
      << "+faststart " << quote(final_mp4) << " 2>&1";
  if (run_cmd(cmd.str()) != 0) {
    error = "ffmpeg concat failed";
    return {};
  }
  return final_mp4;
}

}  // namespace omega::runtime::ffmpeg_media
