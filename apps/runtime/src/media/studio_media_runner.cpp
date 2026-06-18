#include "omega/runtime/media/studio_media_runner.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime::studio_media {

namespace {

std::string resolve_native_media_script() {
  return resolve_content_studio_native_media_script();
}

std::string subprocess_env_prefix() {
  return content_studio_subprocess_env_prefix();
}

std::string shell_quote(const std::string& s) {
#ifdef _WIN32
  if (s.find_first_of(" \t\"") == std::string::npos) return s;
  std::string out = "\"";
  for (char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += "\"";
  return out;
#else
  if (s.find('\'') == std::string::npos) return "'" + s + "'";
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
#endif
}

int run_shell_wait(const std::string& cmd) {
  return system(cmd.c_str());
}

std::string read_file_tail(const fs::path& path, size_t max_chars = 1200) {
  std::ifstream in(path);
  if (!in) return {};
  const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (text.size() <= max_chars) return text;
  return text.substr(text.size() - max_chars);
}

}  // namespace

bool looks_like_studio_pack(const std::string& model_id) {
  std::string s = model_id;
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (s.find("generation-models") != std::string::npos) return true;
  if (s.find("interdiffusion") != std::string::npos) return true;
  if (s.find("diffusers") != std::string::npos) return true;
  if (s.find("qwen") != std::string::npos && s.find("tts") != std::string::npos) return true;
  return false;
}

bool looks_like_ollama_image_model(const std::string& model_id) {
  const std::string s = model_id;
  if (s.empty()) return false;
  if (looks_like_studio_pack(s)) return false;
  if (s.find('/') != std::string::npos) return false;
  if (s.size() > 48) return false;
  return true;
}

bool prefer_studio_images_phase(const std::string& image_model) {
  if (image_model.empty()) return true;
  if (looks_like_studio_pack(image_model)) return true;
  if (looks_like_ollama_image_model(image_model)) return false;
  if (image_model.find('/') != std::string::npos) return true;
  return false;
}

bool subprocess_ready() {
  return fs::exists(resolve_unified_python()) &&
         fs::exists(resolve_content_studio_native_media_script()) &&
         fs::exists(resolve_content_studio_backend());
}

PhaseResult run_phase(const std::string& phase, const json& request) {
  PhaseResult result;
  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    result.error = "unified Python venv missing — run POST /v1/python/setup";
    return result;
  }
  const std::string script = resolve_native_media_script();
  if (!fs::exists(script)) {
    result.error = "native_media_phase.py not found: " + script;
    return result;
  }
  const std::string backend = resolve_content_studio_backend();
  if (!fs::exists(backend)) {
    result.error = "Content Studio backend not found";
    return result;
  }

  const fs::path tmp_dir = fs::path(omega_home()) / "content-studio" / "tmp";
  fs::create_directories(tmp_dir);
  const std::string token = random_uuid();
  const fs::path req_path = tmp_dir / ("native_media_" + phase + "_" + token + "_req.json");
  const fs::path resp_path = tmp_dir / ("native_media_" + phase + "_" + token + "_resp.json");
  const fs::path log_path = tmp_dir / ("native_media_" + phase + "_" + token + ".log");
  {
    std::ofstream out(req_path);
    json body = request;
    body["phase"] = phase;
    out << body.dump();
  }

  std::ostringstream cmd;
  cmd << subprocess_env_prefix();
#ifdef _WIN32
  cmd << "cd /d " << shell_quote(backend) << " && " << shell_quote(py) << " " << shell_quote(script)
      << " --request-file " << shell_quote(req_path.string()) << " --response-file "
      << shell_quote(resp_path.string()) << " > " << shell_quote(log_path.string()) << " 2>&1";
#else
  cmd << "cd " << shell_quote(backend) << " && " << shell_quote(py) << " " << shell_quote(script)
      << " --request-file " << shell_quote(req_path.string()) << " --response-file "
      << shell_quote(resp_path.string()) << " > " << shell_quote(log_path.string()) << " 2>&1";
#endif

  const int code = run_shell_wait(cmd.str());

  auto cleanup = [&]() {
    std::error_code ec;
    fs::remove(req_path, ec);
  };

  if (!fs::exists(resp_path)) {
    cleanup();
    result.error = "native media phase produced no response file (exit " + std::to_string(code) +
                   "). Log: " + read_file_tail(log_path);
    return result;
  }

  std::ifstream in(resp_path);
  if (!in) {
    cleanup();
    result.error = "failed to read native media response file";
    return result;
  }
  const std::string resp_text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  cleanup();
  std::error_code ec;
  fs::remove(resp_path, ec);

  try {
    const json parsed = json::parse(resp_text);
    result.ok = parsed.value("ok", false);
    result.summary = parsed.value("summary", "");
    result.error = parsed.value("error", "");
    if (!result.ok && result.error.empty()) {
      result.error = "native media phase failed (exit " + std::to_string(code) + ")";
    }
    if (!result.ok && parsed.contains("traceback") && parsed["traceback"].is_string()) {
      const std::string tb = parsed["traceback"].get<std::string>();
      if (!tb.empty()) result.error += "\n" + tb.substr(0, std::min<size_t>(800, tb.size()));
    }
    if (!result.ok && result.error.find("Log:") == std::string::npos) {
      const std::string tail = read_file_tail(log_path, 600);
      if (!tail.empty()) result.error += "\n--- log tail ---\n" + tail;
    }
    return result;
  } catch (const std::exception& e) {
    result.error = std::string("failed to parse native media response: ") + e.what() + "\n" +
                    read_file_tail(log_path, 600);
    return result;
  }
}

}  // namespace omega::runtime::studio_media
