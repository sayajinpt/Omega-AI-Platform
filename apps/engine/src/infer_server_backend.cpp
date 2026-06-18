#include "omega/engine/infer_server_backend.hpp"

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <sstream>
#include <thread>
#include <vector>

#include <httplib.h>

namespace fs = std::filesystem;
namespace omega::engine {

namespace {

using json = nlohmann::json;

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winsock2.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

int pick_free_port() {
#ifdef _WIN32
  WSADATA wsa{};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 0;
#endif
  const int fd = static_cast<int>(socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
  if (fd < 0) return 0;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
#ifdef _WIN32
    closesocket(fd);
    WSACleanup();
#else
    close(fd);
#endif
    return 0;
  }
  socklen_t len = sizeof(addr);
  getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len);
  const int port = ntohs(addr.sin_port);
#ifdef _WIN32
  closesocket(fd);
  WSACleanup();
#else
  close(fd);
#endif
  return port;
}

std::string quote_arg(const std::string& arg) {
  if (arg.find_first_of(" \t\"") == std::string::npos) return arg;
  std::string out = "\"";
  for (char c : arg) {
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else out += c;
  }
  out += "\"";
  return out;
}

std::string extract_token_text(const json& chunk) {
  if (chunk.contains("content") && chunk["content"].is_string()) {
    return chunk["content"].get<std::string>();
  }
  if (chunk.contains("choices") && chunk["choices"].is_array() && !chunk["choices"].empty()) {
    const auto& choice = chunk["choices"][0];
    if (choice.contains("delta") && choice["delta"].is_object()) {
      const auto& delta = choice["delta"];
      if (delta.contains("content") && delta["content"].is_string()) {
        return delta["content"].get<std::string>();
      }
    }
    if (choice.contains("text") && choice["text"].is_string()) {
      return choice["text"].get<std::string>();
    }
  }
  return {};
}

void apply_timings(const json& chunk, GenerationStats* stats) {
  if (!stats || !chunk.contains("timings") || !chunk["timings"].is_object()) return;
  const auto& t = chunk["timings"];
  const int pn = t.value("prompt_n", 0);
  const int pred = t.value("predicted_n", 0);
  if (pn > 0) stats->prompt_tokens = pn;
  if (pred > 0) stats->completion_tokens = pred;
  const double pms = t.value("prompt_ms", 0.0);
  const double gms = t.value("predicted_ms", 0.0);
  if (pms > 0) {
    stats->prompt_ms_f = pms;
    stats->prompt_ms = static_cast<int64_t>(pms);
  }
  if (gms > 0) {
    stats->gen_ms_f = gms;
    stats->gen_ms = static_cast<int64_t>(gms);
  }
}

bool process_sse_line(std::string line, TokenCallback& on_token, std::string& full_text, int& index,
                      GenerationStats* stats) {
  while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) line.pop_back();
  if (line.empty()) return true;
  if (line.rfind("data: ", 0) == 0) line = line.substr(6);
  if (line.rfind("data:", 0) == 0) {
    std::string payload = line.substr(5);
    while (!payload.empty() && payload.front() == ' ') payload.erase(payload.begin());
    line = std::move(payload);
  }
  if (line == "[DONE]") return true;
  json chunk;
  try {
    chunk = json::parse(line);
  } catch (...) {
    return true;
  }
  apply_timings(chunk, stats);
  if (chunk.contains("usage") && chunk["usage"].is_object()) {
    const auto& u = chunk["usage"];
    if (stats) {
      const int pi = u.value("prompt_tokens", 0);
      const int co = u.value("completion_tokens", 0);
      if (pi > 0) stats->prompt_tokens = pi;
      if (co > 0) stats->completion_tokens = co;
    }
  }
  const std::string text = extract_token_text(chunk);
  if (text.empty()) return true;
  full_text += text;
  if (on_token && !on_token({text, index++})) return false;
  if (stats) stats->completion_tokens = std::max(stats->completion_tokens, index);
  return true;
}

std::vector<std::string> build_load_args(const std::string& model_path, const LoadOptions& load,
                                          const SpeculativeOptions& spec, int port) {
  const LoadOptions cfg = InferenceService::default_load(load);
  std::vector<std::string> args;
  args.push_back("-m");
  args.push_back(model_path);
  args.push_back("--port");
  args.push_back(std::to_string(port));
  args.push_back("--host");
  args.push_back("127.0.0.1");
  args.push_back("-c");
  args.push_back(std::to_string(cfg.context_size));
  args.push_back("-b");
  args.push_back(std::to_string(cfg.batch_size));
  args.push_back("--parallel");
  args.push_back("1");
  args.push_back("--cont-batching");
  args.push_back("--sleep-idle-seconds");
  args.push_back("-1");
  if (cfg.threads > 0) {
    args.push_back("-t");
    args.push_back(std::to_string(cfg.threads));
  }
  if (cfg.gpu_layers > 0 && cfg.gpu_layers < 999) {
    args.push_back("-ngl");
    args.push_back(std::to_string(cfg.gpu_layers));
  } else if (cfg.gpu_layers >= 999) {
    args.push_back("-ngl");
    args.push_back("999");
  }
  const auto spec_args = speculative_cli_args(spec, model_path);
  args.insert(args.end(), spec_args.begin(), spec_args.end());
  return args;
}

}  // namespace

struct InferServerBackend::Impl {
#ifdef _WIN32
  PROCESS_INFORMATION proc{};
  bool has_proc = false;
#else
  pid_t pid = -1;
#endif
  int port = 0;
  std::string model_path;
};

bool InferServerBackend::infer_binary_available() { return !resolve_infer_binary().empty(); }

std::string InferServerBackend::resolve_infer_binary() {
  if (const char* env = std::getenv("OMEGA_INFER_BIN")) {
    if (env[0] && fs::exists(env)) return env;
  }
  const char* names[] = {
#ifdef _WIN32
      "omega-infer.exe", "llama-server.exe",
#else
      "omega-infer", "llama-server",
#endif
  };
#ifdef _WIN32
  const char sep = ';';
#else
  const char sep = ':';
#endif
  if (const char* path_env = std::getenv("PATH")) {
    std::string paths = path_env;
    size_t start = 0;
    while (start < paths.size()) {
      const size_t pos = paths.find(sep, start);
      const size_t e = pos == std::string::npos ? paths.size() : pos;
      const std::string dir = paths.substr(start, e - start);
      for (const char* name : names) {
        const fs::path candidate = fs::path(dir) / name;
        if (fs::exists(candidate)) return candidate.string();
      }
      if (pos == std::string::npos) break;
      start = pos + 1;
    }
  }
  for (const char* name : names) {
    if (fs::exists(name)) return name;
  }
  return {};
}

InferServerBackend::InferServerBackend() : impl_(std::make_unique<Impl>()) {}

InferServerBackend::~InferServerBackend() { stop(); }

void InferServerBackend::stop() {
  if (!impl_) return;
#ifdef _WIN32
  if (impl_->has_proc) {
    TerminateProcess(impl_->proc.hProcess, 1);
    CloseHandle(impl_->proc.hProcess);
    CloseHandle(impl_->proc.hThread);
    impl_->has_proc = false;
  }
#else
  if (impl_->pid > 0) {
    kill(impl_->pid, SIGTERM);
    int status = 0;
    waitpid(impl_->pid, &status, 0);
    impl_->pid = -1;
  }
#endif
  running_ = false;
  impl_->port = 0;
}

bool InferServerBackend::start(const std::string& model_path, const LoadOptions& load,
                               const SpeculativeOptions& spec, std::string& error) {
  stop();
  const std::string bin = resolve_infer_binary();
  if (bin.empty()) {
    error = "omega-infer not found — set OMEGA_INFER_BIN or add resources/bin to PATH";
    return false;
  }
  const int port = pick_free_port();
  if (port <= 0) {
    error = "failed to allocate local port for omega-infer";
    return false;
  }
  const auto args = build_load_args(model_path, load, spec, port);
  std::ostringstream cmd;
  cmd << quote_arg(bin);
  for (const auto& a : args) cmd << ' ' << quote_arg(a);

#ifdef _WIN32
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  std::vector<char> cmdline(cmd.str().begin(), cmd.str().end());
  cmdline.push_back('\0');
  if (!CreateProcessA(nullptr, cmdline.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      nullptr, &si, &pi)) {
    error = "CreateProcess failed for omega-infer";
    return false;
  }
  impl_->proc = pi;
  impl_->has_proc = true;
#else
  const pid_t pid = fork();
  if (pid < 0) {
    error = "fork failed for omega-infer";
    return false;
  }
  if (pid == 0) {
    std::vector<std::string> storage = args;
    std::vector<char*> argv;
    argv.push_back(const_cast<char*>(bin.c_str()));
    for (auto& s : storage) argv.push_back(s.data());
    argv.push_back(nullptr);
    execv(bin.c_str(), argv.data());
    _exit(127);
  }
  impl_->pid = pid;
#endif

  impl_->port = port;
  impl_->model_path = model_path;

  httplib::Client client("127.0.0.1", port);
  client.set_connection_timeout(5, 0);
  client.set_read_timeout(5, 0);
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(90);
  while (std::chrono::steady_clock::now() < deadline) {
    if (auto res = client.Get("/health")) {
      if (res->status == 200) {
        running_ = true;
        return true;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
  error = "omega-infer infer worker not ready on port " + std::to_string(port);
  stop();
  return false;
}

bool InferServerBackend::stream_completion(const std::string& path, const json& body,
                                           TokenCallback on_token, std::string& full_text,
                                           std::string& error, GenerationStats* stats_out) {
  if (!running_) {
    error = "infer server not running";
    return false;
  }
  httplib::Client client("127.0.0.1", impl_->port);
  client.set_read_timeout(0, 0);
  const std::string payload = body.dump();
  std::string pending;
  int index = 0;
  httplib::Request req;
  req.method = "POST";
  req.path = path;
  req.set_header("Content-Type", "application/json");
  req.body = payload;
  req.content_receiver = [&](const char* data, size_t data_length, uint64_t /*offset*/,
                             uint64_t /*total_length*/) {
    pending.append(data, data_length);
    for (;;) {
      const auto nl = pending.find('\n');
      if (nl == std::string::npos) break;
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!process_sse_line(line, on_token, full_text, index, stats_out)) return false;
    }
    return true;
  };
  auto res = client.send(req);
  if (!res) {
    error = "omega-infer HTTP request failed";
    return false;
  }
  if (res->status != 200) {
    error = "omega-infer returned HTTP " + std::to_string(res->status);
    return false;
  }
  if (!pending.empty()) {
    if (!process_sse_line(pending, on_token, full_text, index, stats_out)) {
      error = "generation aborted";
      return false;
    }
  }
  return true;
}

bool InferServerBackend::generate(const std::string& prompt, const SamplingOptions& sampling,
                                  TokenCallback on_token, std::string& full_text,
                                  std::string& error, GenerationStats* stats_out) {
  const SamplingOptions sp = InferenceService::default_sampling(sampling);
  json body;
  body["prompt"] = prompt;
  body["stream"] = true;
  body["n_predict"] = sp.max_tokens;
  body["temperature"] = sp.temperature;
  body["top_p"] = sp.top_p;
  body["top_k"] = sp.top_k;
  full_text.clear();
  if (stats_out && stats_out->prompt_tokens <= 0) {
    stats_out->prompt_tokens =
        std::max(1, static_cast<int>(prompt.size()) / 4);
  }
  return stream_completion("/completion", body, on_token, full_text, error, stats_out);
}

bool InferServerBackend::chat(const std::vector<ChatMessage>& messages,
                              const SamplingOptions& sampling, TokenCallback on_token,
                              std::string& full_text, std::string& error,
                              GenerationStats* stats_out) {
  const SamplingOptions sp = InferenceService::default_sampling(sampling);
  json msgs = json::array();
  for (const auto& m : messages) {
    json row;
    row["role"] = m.role;
    row["content"] = m.content;
    msgs.push_back(std::move(row));
  }
  json body;
  body["messages"] = std::move(msgs);
  body["stream"] = true;
  body["n_predict"] = sp.max_tokens;
  body["temperature"] = sp.temperature;
  body["top_p"] = sp.top_p;
  body["top_k"] = sp.top_k;
  full_text.clear();
  if (stats_out && stats_out->prompt_tokens <= 0) {
    int est = 0;
    for (const auto& m : messages) {
      est += std::max(1, static_cast<int>(m.content.size()) / 4);
    }
    stats_out->prompt_tokens = est;
  }
  return stream_completion("/v1/chat/completions", body, on_token, full_text, error, stats_out);
}

bool InferServerBackend::embed(const std::string& text, std::vector<float>& vector,
                               std::string& error) {
  if (!running_) {
    error = "infer server not running";
    return false;
  }
  httplib::Client client("127.0.0.1", impl_->port);
  json body;
  body["content"] = text;
  const auto res = client.Post("/embedding", body.dump(), "application/json");
  if (!res || res->status != 200) {
    error = "omega-infer embed failed";
    return false;
  }
  try {
    const json out = json::parse(res->body);
    vector = out.at("embedding").get<std::vector<float>>();
    return true;
  } catch (...) {
    error = "invalid embed response";
    return false;
  }
}

}  // namespace omega::engine
