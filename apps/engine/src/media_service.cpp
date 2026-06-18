#include "omega/engine/media_service.hpp"

#include "omega/engine/infer_server_backend.hpp"
#include "omega/engine/inference_service.hpp"

#ifdef OMEGA_ENGINE_HAVE_INFER
#include "omega_infer.h"
#endif

#include <httplib.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::engine::media {

namespace {

std::string resolve_llama_cli_binary() {
  if (const char* env = std::getenv("OMEGA_LLAMA_CLI_BIN")) {
    if (env[0] && fs::exists(env)) return env;
  }
  const std::string infer = InferServerBackend::resolve_infer_binary();
  if (!infer.empty()) {
    const fs::path dir = fs::path(infer).parent_path();
    const char* names[] = {
#ifdef _WIN32
        "llama-tts.exe", "llama-cli.exe", "llama.exe",
#else
        "llama-tts", "llama-cli", "llama",
#endif
    };
    for (const char* name : names) {
      const fs::path candidate = dir / name;
      if (fs::exists(candidate)) return candidate.string();
    }
  }
#ifdef _WIN32
  const char* path_names[] = {"llama-tts.exe", "llama-cli.exe"};
#else
  const char* path_names[] = {"llama-tts", "llama-cli"};
#endif
  if (const char* path_env = std::getenv("PATH")) {
    std::string paths = path_env;
    size_t start = 0;
    while (start < paths.size()) {
#ifdef _WIN32
      const char sep = ';';
#else
      const char sep = ':';
#endif
      const size_t pos = paths.find(sep, start);
      const size_t e = pos == std::string::npos ? paths.size() : pos;
      const std::string dir = paths.substr(start, e - start);
      for (const char* name : path_names) {
        const fs::path candidate = fs::path(dir) / name;
        if (fs::exists(candidate)) return candidate.string();
      }
      if (pos == std::string::npos) break;
      start = pos + 1;
    }
  }
  return {};
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

int run_command_capture_exit(const std::string& cmd) {
#ifdef _WIN32
  return system(cmd.c_str());
#else
  return system(cmd.c_str());
#endif
}

bool file_nonempty(const fs::path& p) {
  std::error_code ec;
  return fs::exists(p, ec) && fs::file_size(p, ec) > 0;
}

std::string omega_home_dir() {
#ifdef _WIN32
  const char* home = std::getenv("USERPROFILE");
#else
  const char* home = std::getenv("HOME");
#endif
  if (!home || !*home) return {};
  return (fs::path(home) / ".omega").string();
}

int ollama_port() {
  if (const char* host = std::getenv("OLLAMA_HOST")) {
    std::string h = host;
    const auto pos = h.rfind(':');
    if (pos != std::string::npos) {
      try {
        return std::stoi(h.substr(pos + 1));
      } catch (...) {
      }
    }
  }
  const fs::path state = fs::path(omega_home_dir()) / "ollama-state.json";
  if (fs::exists(state)) {
    try {
      std::ifstream in(state);
      const json j = json::parse(in);
      if (j.contains("port")) return j["port"].get<int>();
    } catch (...) {
    }
  }
  return 11434;
}

bool ollama_reachable() {
  httplib::Client cli("127.0.0.1", ollama_port());
  cli.set_connection_timeout(2, 0);
  const auto res = cli.Get("/api/tags");
  return res && res->status >= 200 && res->status < 300;
}

bool decode_base64(const std::string& in, std::string& out) {
  static const char* k =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::vector<int> T(256, -1);
  for (int i = 0; i < 64; ++i) T[static_cast<unsigned char>(k[i])] = i;
  out.clear();
  int val = 0, valb = -8;
  for (unsigned char c : in) {
    if (T[c] == -1) {
      if (c == '=') break;
      continue;
    }
    val = (val << 6) + T[c];
    valb += 6;
    if (valb >= 0) {
      out.push_back(static_cast<char>((val >> valb) & 0xFF));
      valb -= 8;
    }
  }
  return !out.empty();
}

}  // namespace

json capabilities_json() {
  const bool infer = InferenceService::infer_available();
  const bool cli = !resolve_llama_cli_binary().empty();
  const bool ollama_img = ollama_reachable();
  json caps{{"vision", infer},
            {"imageGenerate", false},
            {"ttsGenerate", cli},
            {"ollamaImageAvailable", ollama_img},
            {"imageBackend", "unavailable"},
            {"ttsBackend", cli ? "llama.cpp" : "unavailable"},
            {"llamaCliPresent", cli},
            {"inferAvailable", infer},
            {"policy", "engine_native_ollama_auto"}};
#ifdef OMEGA_ENGINE_HAVE_INFER
  const auto native_caps = omega_infer_capabilities();
  caps["vision"] = native_caps.vision != 0;
#endif
  return caps;
}

json tts_generate(ModelRegistry& registry, const json& payload, std::string& error) {
  const std::string text = payload.value("text", "");
  if (text.empty()) {
    error = "text required";
    return json{{"ok", false}, {"fallback", "ollama"}};
  }

  std::string out_path = payload.value("outPath", payload.value("wavPath", ""));
  if (out_path.empty()) {
    error = "outPath required";
    return json{{"ok", false}, {"fallback", "ollama"}};
  }

  const std::string cli = resolve_llama_cli_binary();
  if (cli.empty()) {
    error = "llama-cli / llama-tts not found next to omega-infer — use Ollama TTS fallback";
    return json{{"ok", false}, {"fallback", "ollama"}, {"native", false}};
  }

  std::string model_path;
  const std::string model_id = payload.value("modelId", "");
  if (!model_id.empty()) {
    ModelRecord rec;
    if (!registry.get(model_id, rec)) {
      error = "model not found: " + model_id;
      return json{{"ok", false}, {"fallback", "ollama"}};
    }
    model_path = rec.path;
  }

  fs::create_directories(fs::path(out_path).parent_path());

  std::ostringstream cmd;
  cmd << quote_arg(cli);
  if (!model_path.empty()) {
    cmd << " -m " << quote_arg(model_path);
  } else {
    cmd << " --tts-oute-default";
  }
  cmd << " -p " << quote_arg(text);
  cmd << " -o " << quote_arg(out_path);
  cmd << " --no-display-prompt 2>&1";

  const int code = run_command_capture_exit(cmd.str());
  if (code == 0 && file_nonempty(out_path)) {
    return json{{"ok", true},
                {"native", true},
                {"backend", "llama.cpp"},
                {"wavPath", out_path},
                {"cli", cli}};
  }

  error = "llama.cpp TTS failed (exit " + std::to_string(code) +
          ") — ensure an OuteTTS GGUF is installed or set modelId";
  return json{{"ok", false}, {"fallback", "ollama"}, {"native", false}, {"exitCode", code}};
}

json image_generate(ModelRegistry&, const json& payload, std::string& error) {
  const std::string prompt = payload.value("prompt", "");
  if (prompt.empty()) {
    error = "prompt required";
    return json{{"ok", false}};
  }

  if (!payload.value("allowOllama", false)) {
    error = "no native image model in engine";
    return json{{"ok", false}, {"fallback", "ollama"}};
  }

  if (!ollama_reachable()) {
    error = "Ollama is not running — start Ollama or disable imageGeneration.useOllama";
    return json{{"ok", false}, {"fallback", "ollama"}};
  }

  std::string model = payload.value("ollamaModel", "");
  if (model.empty()) model = payload.value("model", "flux");
  const int width = payload.value("width", 1024);
  const int height = payload.value("height", 1024);

  httplib::Client cli("127.0.0.1", ollama_port());
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(300, 0);
  json body{{"model", model}, {"prompt", prompt}, {"stream", false}};
  if (width > 0 && height > 0) body["options"] = json{{"width", width}, {"height", height}};

  const auto res = cli.Post("/api/generate", body.dump(), "application/json");
  if (!res || res->status >= 400) {
    error = "Ollama image request failed — pull model: ollama pull " + model;
    return json{{"ok", false}, {"fallback", "ollama"}};
  }

  json parsed;
  try {
    parsed = json::parse(res->body);
  } catch (...) {
    error = "invalid Ollama response";
    return json{{"ok", false}};
  }

  std::string bytes_b64;
  if (parsed.contains("images") && parsed["images"].is_array() && !parsed["images"].empty()) {
    bytes_b64 = parsed["images"][0].get<std::string>();
  } else if (parsed.contains("response") && parsed["response"].is_string()) {
    bytes_b64 = parsed["response"].get<std::string>();
  }
  if (bytes_b64.empty()) {
    error = "no image bytes in Ollama response";
    return json{{"ok", false}};
  }

  std::string out_path = payload.value("outPath", payload.value("path", ""));
  std::string raw;
  if (!decode_base64(bytes_b64, raw)) {
    error = "failed to decode image";
    return json{{"ok", false}};
  }

  if (!out_path.empty()) {
    fs::create_directories(fs::path(out_path).parent_path());
    std::ofstream out(out_path, std::ios::binary);
    out.write(raw.data(), static_cast<std::streamsize>(raw.size()));
    return json{{"ok", true}, {"native", true}, {"backend", "ollama"}, {"path", out_path}};
  }

  return json{{"ok", true},
              {"native", true},
              {"backend", "ollama"},
              {"pngBase64", bytes_b64},
              {"byteLength", raw.size()}};
}

}  // namespace omega::engine::media
