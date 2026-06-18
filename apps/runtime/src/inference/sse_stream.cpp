#include "omega/runtime/inference/sse_stream.hpp"

#include "omega/runtime/net/https_client.hpp"

#include <stdexcept>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

void trim_crlf(std::string& line) {
  while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
}

std::string sse_payload_from_line(std::string line) {
  trim_crlf(line);
  if (line.rfind("data:", 0) == 0) {
    std::string payload = line.substr(5);
    while (!payload.empty() && payload.front() == ' ') payload.erase(payload.begin());
    return payload;
  }
  return line;
}

}  // namespace

bool feed_openai_sse_payload(const std::string& payload, OpenAiSseAccum& acc,
                             ChatTokenCallback on_token, int& index) {
  if (payload.empty() || payload == "[DONE]") return true;
  json j;
  try {
    j = json::parse(payload);
  } catch (...) {
    return true;
  }
  if (j.contains("usage") && j["usage"].is_object()) {
    const auto& u = j["usage"];
    const int pi = u.value("prompt_tokens", 0);
    const int co = u.value("completion_tokens", 0);
    if (pi > 0) acc.tokens_in = pi;
    if (co > 0) acc.tokens_out = co;
    const int pec = u.value("prompt_eval_count", 0);
    const int ec = u.value("eval_count", 0);
    if (pec > 0) acc.tokens_in = pec;
    if (ec > 0) acc.tokens_out = ec;
  }
  const int pec = j.value("prompt_eval_count", 0);
  const int ec = j.value("eval_count", 0);
  if (pec > 0) acc.tokens_in = pec;
  if (ec > 0) acc.tokens_out = ec;

  if (j.contains("choices") && j["choices"].is_array() && !j["choices"].empty()) {
    const auto& c0 = j["choices"][0];
    if (c0.contains("delta") && c0["delta"].is_object()) {
      const auto& delta = c0["delta"];
      if (delta.contains("content") && delta["content"].is_string()) {
        const std::string delta_text = delta["content"].get<std::string>();
        if (!delta_text.empty()) {
          acc.text += delta_text;
          if (on_token) on_token(delta_text, index++);
        }
      }
    }
    if (c0.contains("message") && c0["message"].is_object()) {
      const auto& msg = c0["message"];
      if (msg.contains("content") && msg["content"].is_string()) {
        const std::string delta_text = msg["content"].get<std::string>();
        if (!delta_text.empty()) {
          acc.text += delta_text;
          if (on_token) on_token(delta_text, index++);
        }
      }
    }
  }
  return true;
}

bool feed_openai_sse_line(std::string line, OpenAiSseAccum& acc, ChatTokenCallback on_token,
                          int& index) {
  const std::string payload = sse_payload_from_line(std::move(line));
  if (payload.empty()) return true;
  return feed_openai_sse_payload(payload, acc, on_token, index);
}

void stream_openai_sse_post(httplib::Client& cli, const std::string& path,
                            const httplib::Headers& headers, const std::string& body,
                            OpenAiSseAccum& acc, ChatTokenCallback on_token) {
  std::string pending;
  int index = 0;
  httplib::Request req;
  req.method = "POST";
  req.path = path;
  for (const auto& h : headers) req.set_header(h.first, h.second);
  req.body = body;
  req.content_receiver = [&](const char* data, size_t data_length, uint64_t, uint64_t) {
    pending.append(data, data_length);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!feed_openai_sse_line(line, acc, on_token, index)) {
        throw std::runtime_error("chat stream aborted");
      }
    }
    return true;
  };
  const auto res = cli.send(req);
  if (!res) throw std::runtime_error("HTTP stream request failed");
  if (res->status < 200 || res->status >= 300) {
    throw std::runtime_error("HTTP " + std::to_string(res->status) + ": " +
                             res->body.substr(0, 280));
  }
  if (!pending.empty()) {
    if (!feed_openai_sse_line(pending, acc, on_token, index)) {
      throw std::runtime_error("chat stream aborted");
    }
  }
}

void stream_openai_sse_post_url(const std::string& url,
                                const std::map<std::string, std::string>& headers,
                                const std::string& body, OpenAiSseAccum& acc,
                                ChatTokenCallback on_token) {
  std::string pending;
  int index = 0;
  https::RequestOptions opts;
  opts.headers = headers;
  opts.connection_timeout_sec = 15;
  opts.read_timeout_sec = 600;
  const auto res = https::post_stream(url, body, opts, [&](const char* data, size_t len) {
    pending.append(data, len);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!feed_openai_sse_line(line, acc, on_token, index)) {
        throw std::runtime_error("chat stream aborted");
      }
    }
    return true;
  });
  if (res.status < 200 || res.status >= 300) {
    throw std::runtime_error("HTTP " + std::to_string(res.status) + ": " +
                             res.body.substr(0, 280));
  }
  if (!pending.empty()) {
    if (!feed_openai_sse_line(pending, acc, on_token, index)) {
      throw std::runtime_error("chat stream aborted");
    }
  }
}

bool feed_anthropic_sse_line(std::string line, AnthropicSseAccum& acc, ChatTokenCallback on_token,
                             int& index) {
  const std::string payload = sse_payload_from_line(std::move(line));
  if (payload.empty() || payload == "[DONE]") return true;
  json j;
  try {
    j = json::parse(payload);
  } catch (...) {
    return true;
  }
  const std::string type = j.value("type", "");
  if (type == "message_start" && j.contains("message") && j["message"].contains("usage")) {
    const auto& u = j["message"]["usage"];
    const int tin = u.value("input_tokens", 0);
    if (tin > 0) acc.tokens_in = tin;
  }
  if (type == "message_delta" && j.contains("usage")) {
    const auto& u = j["usage"];
    const int tout = u.value("output_tokens", 0);
    if (tout > 0) acc.tokens_out = tout;
  }
  if (type == "content_block_delta" && j.contains("delta") && j["delta"].contains("text")) {
    const std::string delta = j["delta"]["text"].get<std::string>();
    if (!delta.empty()) {
      acc.text += delta;
      if (on_token) on_token(delta, index++);
    }
  }
  return true;
}

void stream_anthropic_sse_post(httplib::Client& cli, const std::string& path,
                               const httplib::Headers& headers, const std::string& body,
                               AnthropicSseAccum& acc, ChatTokenCallback on_token) {
  std::string pending;
  int index = 0;
  httplib::Request req;
  req.method = "POST";
  req.path = path;
  for (const auto& h : headers) req.set_header(h.first, h.second);
  req.body = body;
  req.content_receiver = [&](const char* data, size_t data_length, uint64_t, uint64_t) {
    pending.append(data, data_length);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!feed_anthropic_sse_line(line, acc, on_token, index)) {
        throw std::runtime_error("anthropic stream aborted");
      }
    }
    return true;
  };
  const auto res = cli.send(req);
  if (!res) throw std::runtime_error("Anthropic stream request failed");
  if (res->status < 200 || res->status >= 300) {
    throw std::runtime_error("Anthropic HTTP " + std::to_string(res->status) + ": " +
                             res->body.substr(0, 280));
  }
  if (!pending.empty()) {
    if (!feed_anthropic_sse_line(pending, acc, on_token, index)) {
      throw std::runtime_error("anthropic stream aborted");
    }
  }
}

void stream_anthropic_sse_post_url(const std::string& url,
                                   const std::map<std::string, std::string>& headers,
                                   const std::string& body, AnthropicSseAccum& acc,
                                   ChatTokenCallback on_token) {
  std::string pending;
  int index = 0;
  https::RequestOptions opts;
  opts.headers = headers;
  opts.connection_timeout_sec = 15;
  opts.read_timeout_sec = 600;
  const auto res = https::post_stream(url, body, opts, [&](const char* data, size_t len) {
    pending.append(data, len);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!feed_anthropic_sse_line(line, acc, on_token, index)) {
        throw std::runtime_error("anthropic stream aborted");
      }
    }
    return true;
  });
  if (res.status < 200 || res.status >= 300) {
    throw std::runtime_error("Anthropic HTTP " + std::to_string(res.status) + ": " +
                             res.body.substr(0, 280));
  }
  if (!pending.empty()) {
    if (!feed_anthropic_sse_line(pending, acc, on_token, index)) {
      throw std::runtime_error("anthropic stream aborted");
    }
  }
}

bool feed_ollama_ndjson_line(std::string line, OpenAiSseAccum& acc, ChatTokenCallback on_token,
                             int& index) {
  while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
  if (line.empty()) return true;
  json j;
  try {
    j = json::parse(line);
  } catch (...) {
    return true;
  }
  if (j.contains("prompt_eval_count")) acc.tokens_in = j.value("prompt_eval_count", acc.tokens_in);
  if (j.contains("eval_count")) acc.tokens_out = j.value("eval_count", acc.tokens_out);

  std::string chunk;
  if (j.contains("message") && j["message"].is_object()) {
  const auto& msg = j["message"];
    if (msg.contains("content") && msg["content"].is_string()) chunk = msg["content"].get<std::string>();
  }
  if (chunk.empty() && j.contains("response") && j["response"].is_string()) {
    chunk = j["response"].get<std::string>();
  }
  if (!chunk.empty()) {
    acc.text += chunk;
    if (on_token) on_token(chunk, index++);
  }
  return true;
}

void stream_ollama_ndjson_post(httplib::Client& cli, const std::string& path,
                               const httplib::Headers& headers, const std::string& body,
                               OpenAiSseAccum& acc, ChatTokenCallback on_token) {
  std::string pending;
  int index = 0;
  httplib::Request req;
  req.method = "POST";
  req.path = path;
  for (const auto& h : headers) req.set_header(h.first, h.second);
  req.body = body;
  req.content_receiver = [&](const char* data, size_t data_length, uint64_t, uint64_t) {
    pending.append(data, data_length);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!feed_ollama_ndjson_line(line, acc, on_token, index)) {
        throw std::runtime_error("ollama stream aborted");
      }
    }
    return true;
  };
  const auto res = cli.send(req);
  if (!res) throw std::runtime_error("Ollama stream request failed");
  if (res->status < 200 || res->status >= 300) {
    throw std::runtime_error("Ollama HTTP " + std::to_string(res->status) + ": " +
                             res->body.substr(0, 280));
  }
  if (!pending.empty()) {
    if (!feed_ollama_ndjson_line(pending, acc, on_token, index)) {
      throw std::runtime_error("ollama stream aborted");
    }
  }
}

}  // namespace omega::runtime
