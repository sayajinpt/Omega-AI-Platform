#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

/** Estimate token count (~4 chars per token). */
int estimate_tokens(const std::string& content);

/** Chat-template tokens not counted in raw message content estimates. */
int chat_template_overhead_tokens(bool agent_mode = false);

/**
 * Max decode tokens for one round: model context minus prompt estimate.
 * If requested_max_tokens > 0, caps to that (chat sampling / UI limit).
 */
int compute_generation_max_tokens(int context_size_tokens, int prompt_tokens_est,
                                  int requested_max_tokens = 0);

/** Trim messages to fit context budget (mirrors TS trimMessagesForInference). */
nlohmann::json trim_messages_for_inference(const nlohmann::json& messages, int context_size_tokens,
                                           bool agent_mode = false);

/** Agent turns: slim recent session messages (tail kept; bulky code stripped). */
nlohmann::json compact_messages_for_agent_inference(const nlohmann::json& messages);

/** @deprecated Prefer compact_messages_for_agent_inference — kept for tests. */
nlohmann::json last_user_message_only(const nlohmann::json& messages);

int count_user_messages_in_array(const nlohmann::json& messages);

}  // namespace omega::runtime
