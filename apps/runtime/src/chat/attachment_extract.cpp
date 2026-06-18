#include "omega/runtime/chat/attachment_extract.hpp"

#include "omega/runtime/inference/ollama_supervisor.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string capture_command_output(const std::string& cmd) {
#ifdef _WIN32
  FILE* pipe = _popen(cmd.c_str(), "r");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return "";
  std::string out;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) out += buf;
#ifdef _WIN32
  _pclose(pipe);
#else
  pclose(pipe);
#endif
  return out;
}

std::string resolve_stt_model(const json& config) {
  const json chat = config.value("chat", json::object());
  std::string model = chat.value("attachmentSttModel", "");
  if (model.empty()) {
    const json tools = config.value("omegaTools", json::object());
    const std::string voice = tools.value("voiceSttModelId", "browser");
    if (!voice.empty() && voice != "browser") model = voice;
  }
  if (model.empty()) model = "whisper";
  static const std::regex prefix_re(R"(^ollama:)", std::regex_constants::icase);
  return std::regex_replace(model, prefix_re, "");
}

}  // namespace

std::string extract_pdf_text(const std::string& path) {
  if (path.empty() || !fs::exists(path)) return "";

  const std::string quoted = "\"" + path + "\"";
#ifdef _WIN32
  const char* candidates[] = {"pdftotext.exe", "pdftotext"};
#else
  const char* candidates[] = {"pdftotext"};
#endif
  for (const char* exe : candidates) {
    const std::string cmd = std::string(exe) + " -q -enc UTF-8 " + quoted + " -";
    std::string out = capture_command_output(cmd);
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r')) out.pop_back();
    if (out.size() >= 8) return out;
  }

  return "";
}

std::optional<std::string> transcribe_audio_attachment(const std::string& path,
                                                       const json& config) {
  if (path.empty() || !fs::exists(path)) return std::nullopt;

  const json chat = config.value("chat", json::object());
  if (chat.value("attachmentSttEnabled", true) == false) return std::nullopt;

  try {
    auto& ollama = OllamaSupervisor::instance();
    if (!ollama.ensure_started()) return std::nullopt;

    const std::string model = resolve_stt_model(config);
    const std::string base = ollama.base_url();

    std::ifstream in(path, std::ios::binary);
    if (!in) return std::nullopt;
    const std::string audio_bytes((std::istreambuf_iterator<char>(in)),
                                  std::istreambuf_iterator<char>());
    if (audio_bytes.empty()) return std::nullopt;

    const std::string filename = fs::path(path).filename().string();
    httplib::Client cli(base.c_str());
    cli.set_connection_timeout(15, 0);
    cli.set_read_timeout(300, 0);

    httplib::MultipartFormDataItems items = {
        {"file", audio_bytes, filename.empty() ? "audio.wav" : filename, "application/octet-stream"},
        {"model", model, "", "text/plain"},
    };

    const auto res = cli.Post("/api/transcribe", items);
    if (!res || res->status < 200 || res->status >= 300) return std::nullopt;

    try {
      const json body = json::parse(res->body);
      const std::string text = body.value("text", "");
      if (!text.empty()) return text;
    } catch (...) {
    }
    std::string plain = res->body;
    while (!plain.empty() && (plain.front() == '"' || plain.front() == ' ')) plain.erase(plain.begin());
    while (!plain.empty() && (plain.back() == '"' || plain.back() == '\n')) plain.pop_back();
    if (plain.size() >= 2) return plain;
  } catch (...) {
  }
  return std::nullopt;
}

}  // namespace omega::runtime
