#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime::ffmpeg_media {

std::optional<std::filesystem::path> resolve_system_font_path();

std::string overlay_caption_for_scene(const nlohmann::json& scene);

/** Write ``caption_NN.txt`` under ``segments_dir``; returns filename or empty. */
std::string write_caption_textfile(const std::filesystem::path& segments_dir, int scene_number,
                                   const std::string& caption);

std::string video_filter_with_caption(const std::string& base_vf, const std::string& caption,
                                      int width, int height, const std::string& fontfile = "",
                                      const std::string& textfile = "");

}  // namespace omega::runtime::ffmpeg_media
