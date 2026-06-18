#pragma once

#include <nlohmann/json.hpp>

namespace omega::runtime {

int estimate_messages_tokens(const nlohmann::json& messages);

/** Ensures tokens_in/tokens_out are populated (API counts preferred, else estimates). */
nlohmann::json normalize_chat_result(const nlohmann::json& data,
                                     const nlohmann::json& messages);

nlohmann::json make_chat_result(const std::string& text, int64_t gen_ms, int tokens_in = 0,
                                int tokens_out = 0);

}  // namespace omega::runtime
