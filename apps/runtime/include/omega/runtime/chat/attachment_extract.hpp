#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

/** Extract UTF-8 text from PDF (pdftotext on PATH, else empty). */
std::string extract_pdf_text(const std::string& path);

/** Transcribe audio via Ollama /api/transcribe when configured; nullopt on skip/failure. */
std::optional<std::string> transcribe_audio_attachment(const std::string& path,
                                                       const nlohmann::json& config);

}  // namespace omega::runtime
