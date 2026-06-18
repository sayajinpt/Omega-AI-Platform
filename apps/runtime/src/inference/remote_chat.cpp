#include "omega/runtime/inference/remote_chat.hpp"

#include "omega/runtime/chat/media_encode.hpp"
#include "omega/runtime/inference/chat_usage.hpp"
#include "omega/runtime/inference/sse_stream.hpp"

#include <chrono>
#include <httplib.h>
#include <regex>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string trim_slash(std::string url) {
  while (!url.empty() && url.back() == '/') url.pop_back();
  return url;
}

httplib::Headers auth_headers(const json& provider) {
  httplib::Headers h{{"Content-Type", "application/json"}};
  if (provider.contains("headers") && provider["headers"].is_object()) {
    for (auto it = provider["headers"].begin(); it != provider["headers"].end(); ++it) {
      if (it.value().is_string()) h.emplace(it.key(), it.value().get<std::string>());
    }
  }
  const std::string id = provider.value("id", "");
  const std::string base = provider.value("baseUrl", "");
  if (id == "openrouter" || base.find("openrouter.ai") != std::string::npos) {
    if (!h.count("HTTP-Referer")) h.emplace("HTTP-Referer", "https://github.com/omega-ai/omega");
    if (!h.count("X-Title")) h.emplace("X-Title", "Omega");
  }
  const std::string key = provider.value("apiKey", "");
  if (key.empty()) return h;
  const std::string kind = provider.value("kind", "openai");
  if (kind == "anthropic") {
    h.emplace("x-api-key", key);
    h.emplace("anthropic-version", "2023-06-01");
  } else {
    h.emplace("Authorization", "Bearer " + key);
  }
  return h;
}

void publish_live_metrics(const ChatMetricsCallback& on_metrics, const OpenAiSseAccum& acc,
                          int64_t stream_start_ms, int64_t& first_token_ms, int index) {
  if (!on_metrics || index < 0) return;
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();
  if (first_token_ms == 0) first_token_ms = now;
  json m;
  m["measured"] = acc.tokens_in > 0 || acc.tokens_out > 0;
  if (acc.tokens_in > 0) m["prompt_tokens"] = acc.tokens_in;
  m["completion_tokens"] = acc.tokens_out > 0 ? acc.tokens_out : index + 1;
  const double prompt_ms = static_cast<double>(first_token_ms - stream_start_ms);
  const double gen_ms = static_cast<double>(now - first_token_ms);
  if (prompt_ms > 0) m["prompt_ms"] = prompt_ms;
  if (gen_ms > 0) m["gen_ms"] = gen_ms;
  m["phase"] = "decode";
  on_metrics(m);
}

ChatTokenCallback wrap_stream_metrics(ChatTokenCallback on_token,
                                      const ChatMetricsCallback& on_metrics,
                                      OpenAiSseAccum& acc, int64_t stream_start_ms,
                                      int64_t& first_token_ms) {
  return [&acc, stream_start_ms, &first_token_ms, on_token = std::move(on_token),
          on_metrics](const std::string& text, int index) {
    publish_live_metrics(on_metrics, acc, stream_start_ms, first_token_ms, index);
    if (on_token) on_token(text, index);
  };
}

json anthropic_chat(const json& provider, const std::string& model, const json& payload,
                    ChatTokenCallback on_token) {
  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  json messages = payload.contains("messages") ? payload["messages"] : json::array();
  json sampling = payload.contains("sampling") ? payload["sampling"] : json::object();
  std::string system_text;
  json anthropic_messages = json::array();
  for (const auto& m : messages) {
    const std::string role = m.value("role", "");
    const std::string content = m.value("content", "");
    if (role == "system") {
      system_text = content;
      continue;
    }
    anthropic_messages.push_back(json{{"role", role == "assistant" ? "assistant" : "user"},
                                      {"content", content}});
  }
  json body{{"model", model},
            {"max_tokens", sampling.value("max_tokens", 2048)},
            {"messages", anthropic_messages},
            {"stream", true}};
  if (!system_text.empty()) body["system"] = system_text;

  const std::string base = trim_slash(provider.value("baseUrl", ""));
  httplib::Client cli(base);
  cli.set_connection_timeout(15, 0);
  cli.set_read_timeout(600, 0);

  AnthropicSseAccum acc;
  stream_anthropic_sse_post(cli, "/v1/messages", auth_headers(provider), body.dump(), acc,
                          on_token);

  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  return make_chat_result(acc.text, gen_ms, acc.tokens_in, acc.tokens_out);
}

}  // namespace

json remote_list_models(const json& provider) {
  const std::string base = trim_slash(provider.value("baseUrl", ""));
  httplib::Client cli(base);
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(30, 0);
  const std::string path =
      provider.value("kind", "") == "anthropic" ? "/v1/models" : "/v1/models";
  const auto res = cli.Get(path.c_str(), auth_headers(provider));
  if (!res) throw std::runtime_error("Failed to reach provider models API");
  if (res->status < 200 || res->status >= 300) {
    throw std::runtime_error("Provider models HTTP " + std::to_string(res->status) + ": " +
                             res->body.substr(0, 200));
  }
  const json body = json::parse(res->body);
  json out = json::array();
  if (body.contains("data") && body["data"].is_array()) {
    for (const auto& m : body["data"]) {
      if (m.contains("id") && m["id"].is_string()) out.push_back(m["id"]);
    }
  }
  return out;
}

json remote_chat(const json& provider, const std::string& model, const json& payload,
                 ChatTokenCallback on_token, ChatMetricsCallback on_metrics, int /*timeout_ms*/) {
  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  const std::string kind = provider.value("kind", "openai");
  if (kind == "anthropic") {
    return anthropic_chat(provider, model, payload, on_token);
  }

  json messages = payload.contains("messages") ? payload["messages"] : json::array();
  if (messages_have_image_paths(messages)) {
    messages = encode_messages_for_openai_vision(messages);
  }
  json sampling = payload.contains("sampling") ? payload["sampling"] : json::object();
  const json body{{"model", model},
                  {"messages", messages},
                  {"stream", true},
                  {"temperature", sampling.value("temperature", 0.7)},
                  {"top_p", sampling.value("top_p", 1.0)},
                  {"max_tokens", sampling.value("max_tokens", 2048)}};

  const std::string base = trim_slash(provider.value("baseUrl", ""));
  httplib::Client cli(base);
  cli.set_connection_timeout(15, 0);
  cli.set_read_timeout(600, 0);

  OpenAiSseAccum acc;
  int64_t first_token_ms = 0;
  const ChatTokenCallback wrapped =
      wrap_stream_metrics(std::move(on_token), on_metrics, acc, start, first_token_ms);
  stream_openai_sse_post(cli, "/v1/chat/completions", auth_headers(provider), body.dump(), acc,
                         wrapped);

  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  return make_chat_result(acc.text, gen_ms, acc.tokens_in, acc.tokens_out);
}

json ollama_chat(const std::string& model_id, const json& payload, ChatTokenCallback on_token,
                 ChatMetricsCallback on_metrics, int /*timeout_ms*/, const std::string& base_url) {
  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  std::string model = model_id;
  static const std::regex prefix_re(R"(^ollama:)", std::regex_constants::icase);
  model = std::regex_replace(model, prefix_re, "");

  json messages = payload.contains("messages") ? payload["messages"] : json::array();
  json sampling = payload.contains("sampling") ? payload["sampling"] : json::object();

  const bool use_native_vision = messages_have_image_paths(messages);
  if (use_native_vision) messages = encode_messages_for_ollama(messages);

  const json body{{"model", model},
                  {"messages", messages},
                  {"stream", true},
                  {"options",
                   json{{"temperature", sampling.value("temperature", 0.7)},
                        {"top_p", sampling.value("top_p", 1.0)},
                        {"num_predict", sampling.value("max_tokens", 2048)}}}};

  const std::string base = trim_slash(base_url);
  httplib::Client cli(base);
  cli.set_connection_timeout(15, 0);
  cli.set_read_timeout(600, 0);
  httplib::Headers h{{"Content-Type", "application/json"}};

  OpenAiSseAccum acc;
  int64_t first_token_ms = 0;
  const ChatTokenCallback wrapped =
      wrap_stream_metrics(std::move(on_token), on_metrics, acc, start, first_token_ms);
  if (use_native_vision) {
    stream_ollama_ndjson_post(cli, "/api/chat", h, body.dump(), acc, wrapped);
  } else {
    const json openai_body{{"model", model},
                           {"messages", messages},
                           {"stream", true},
                           {"temperature", sampling.value("temperature", 0.7)},
                           {"top_p", sampling.value("top_p", 1.0)},
                           {"max_tokens", sampling.value("max_tokens", 2048)}};
    stream_openai_sse_post(cli, "/v1/chat/completions", h, openai_body.dump(), acc, wrapped);
  }

  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  return make_chat_result(acc.text, gen_ms, acc.tokens_in, acc.tokens_out);
}

json sidecar_chat(const json& payload, ChatTokenCallback on_token, ChatMetricsCallback on_metrics,
                  int /*timeout_ms*/, const std::string& base_url) {
  const int64_t start = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  json messages = payload.contains("messages") ? payload["messages"] : json::array();
  json sampling = payload.contains("sampling") ? payload["sampling"] : json::object();
  const json body{{"model", payload.value("model", "sidecar")},
                  {"messages", messages},
                  {"stream", true},
                  {"temperature", sampling.value("temperature", 0.7)},
                  {"top_p", sampling.value("top_p", 1.0)},
                  {"max_tokens", sampling.value("max_tokens", 2048)}};

  const std::string base = trim_slash(base_url);
  httplib::Client cli(base);
  cli.set_connection_timeout(15, 0);
  cli.set_read_timeout(600, 0);
  httplib::Headers h{{"Content-Type", "application/json"}};

  OpenAiSseAccum acc;
  int64_t first_token_ms = 0;
  const ChatTokenCallback wrapped =
      wrap_stream_metrics(std::move(on_token), on_metrics, acc, start, first_token_ms);
  stream_openai_sse_post(cli, "/v1/chat/completions", h, body.dump(), acc, wrapped);

  const int64_t gen_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::system_clock::now().time_since_epoch())
                             .count() -
                         start;
  return make_chat_result(acc.text, gen_ms, acc.tokens_in, acc.tokens_out);
}

}  // namespace omega::runtime
