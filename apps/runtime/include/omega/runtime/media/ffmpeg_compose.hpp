#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime::ffmpeg_media {

std::string find_ffmpeg();
std::string find_ffprobe();

double probe_duration_seconds(const std::filesystem::path& media_path);

/** Write a mono silent WAV (ffmpeg lavfi) so compose can proceed when TTS fails. */
bool write_silent_wav(const std::filesystem::path& wav_path, double duration_seconds);

/** Peak absolute sample value for PCM16 mono WAV; -1 if unreadable. */
int pcm16_wav_peak_abs(const std::filesystem::path& wav_path);

/** Count scene WAVs with peak <= 8 (placeholder / failed TTS). */
int count_nearly_silent_scene_wavs(const std::filesystem::path& audio_dir,
                                   const std::vector<nlohmann::json>& scenes);

/** Assemble scene PNG + WAV pairs into ``final.mp4`` (mirrors Python ``assemble_final_mp4``). */
std::filesystem::path assemble_final_mp4(const std::filesystem::path& job_root,
                                         const nlohmann::json& script_content,
                                         const nlohmann::json& brief_json, std::string& error,
                                         bool include_subtitles = false);

}  // namespace omega::runtime::ffmpeg_media
