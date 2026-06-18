#pragma once

#include <string>

namespace omega::runtime {

/** Remove chat-template stop markers, replacement chars, and other decode artifacts. */
std::string sanitize_assistant_stream_text(std::string text);

/** Full cleanup for SQLite / final assistant rows (includes invalid UTF-8 trimming). */
std::string sanitize_assistant_persist_text(std::string text);

}  // namespace omega::runtime
