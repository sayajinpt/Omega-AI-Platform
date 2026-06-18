#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>

namespace omega::runtime::https {

struct HttpResponse {
  int status{0};
  std::string body;
};

struct RequestOptions {
  std::map<std::string, std::string> headers;
  int connection_timeout_sec{30};
  int read_timeout_sec{600};
  bool follow_redirects{true};
};

using ChunkCallback = std::function<bool(const char* data, size_t len)>;
using ProgressCallback = std::function<bool(uint64_t current, uint64_t total)>;

/** GET https? URL — full body (HF API, small payloads). */
HttpResponse get(const std::string& url, const RequestOptions& opts = {});

/** POST https? URL — full response body. */
HttpResponse post(const std::string& url, const std::string& body,
                  const RequestOptions& opts = {});

/**
 * GET with streaming body (model downloads). Returns final HTTP status.
 * on_progress(current, total) — total may be 0 if unknown.
 */
HttpResponse get_stream(const std::string& url, const RequestOptions& opts, ChunkCallback on_chunk,
                        ProgressCallback on_progress = nullptr);

/**
 * POST with streaming response body (provider chat SSE). Returns final HTTP status.
 * Response bytes are delivered to on_chunk as they arrive; they are not stored unless
 * the callback appends them.
 */
HttpResponse post_stream(const std::string& url, const std::string& body,
                         const RequestOptions& opts, ChunkCallback on_chunk);

}  // namespace omega::runtime::https
