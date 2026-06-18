#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

bool messages_have_image_paths(const nlohmann::json& messages);

/** Ollama /api/chat: imagePaths → base64 `images` arrays; strips imagePaths. */
nlohmann::json encode_messages_for_ollama(const nlohmann::json& messages);

/** OpenAI-compatible multimodal content blocks from imagePaths. */
nlohmann::json encode_messages_for_openai_vision(const nlohmann::json& messages);

std::string read_file_base64(const std::string& path);
std::string image_mime_from_path(const std::string& path);

}  // namespace omega::runtime
