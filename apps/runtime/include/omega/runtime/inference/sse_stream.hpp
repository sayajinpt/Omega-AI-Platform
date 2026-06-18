#pragma once

#include "omega/runtime/engine_client.hpp"

#include <functional>
#include <httplib.h>
#include <map>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

struct OpenAiSseAccum {
  std::string text;
  int tokens_in{0};
  int tokens_out{0};
};

/** Parse one SSE `data:` payload (OpenAI chat completions stream). Returns false to abort. */
bool feed_openai_sse_payload(const std::string& payload, OpenAiSseAccum& acc,
                             ChatTokenCallback on_token, int& index);

/** Incrementally process a raw SSE line (with or without `data:` prefix). */
bool feed_openai_sse_line(std::string line, OpenAiSseAccum& acc, ChatTokenCallback on_token,
                          int& index);

/**
 * POST with streaming body; invokes feed_openai_sse_line for each SSE line as it arrives.
 * Throws std::runtime_error on HTTP failure.
 */
void stream_openai_sse_post(httplib::Client& cli, const std::string& path,
                            const httplib::Headers& headers, const std::string& body,
                            OpenAiSseAccum& acc, ChatTokenCallback on_token);

/** Same as stream_openai_sse_post but uses omega::runtime::https (WinHTTP on Windows). */
void stream_openai_sse_post_url(const std::string& url,
                                const std::map<std::string, std::string>& headers,
                                const std::string& body, OpenAiSseAccum& acc,
                                ChatTokenCallback on_token);

struct AnthropicSseAccum {
  std::string text;
  int tokens_in{0};
  int tokens_out{0};
};

bool feed_anthropic_sse_line(std::string line, AnthropicSseAccum& acc, ChatTokenCallback on_token,
                             int& index);

void stream_anthropic_sse_post(httplib::Client& cli, const std::string& path,
                               const httplib::Headers& headers, const std::string& body,
                               AnthropicSseAccum& acc, ChatTokenCallback on_token);

void stream_anthropic_sse_post_url(const std::string& url,
                                   const std::map<std::string, std::string>& headers,
                                   const std::string& body, AnthropicSseAccum& acc,
                                   ChatTokenCallback on_token);

/** Ollama native /api/chat — newline-delimited JSON (not SSE). */
void stream_ollama_ndjson_post(httplib::Client& cli, const std::string& path,
                               const httplib::Headers& headers, const std::string& body,
                               OpenAiSseAccum& acc, ChatTokenCallback on_token);

}  // namespace omega::runtime
