#include "omega/runtime/services/editor_service.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string read_path(const fs::path& path) {
  if (!fs::exists(path)) throw std::runtime_error("File not found: " + path.string());
  std::ifstream in(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

json file_entry(const std::string& path) {
  return json{{"path", path},
              {"content", read_path(path)},
              {"language", EditorService::language_from_path(path)},
              {"title", EditorService::title_from_path(path)}};
}

}  // namespace

std::string EditorService::read_file(const std::string& path) {
  return read_path(fs::path(path));
}

void EditorService::write_file(const std::string& path, const std::string& content) {
  const fs::path p(path);
  fs::create_directories(p.parent_path());
  std::ofstream out(p, std::ios::binary);
  if (!out) throw std::runtime_error("failed to write: " + path);
  out << content;
}

void EditorService::delete_file(const std::string& path) {
  const fs::path p = fs::absolute(path);
  if (!fs::exists(p)) throw std::runtime_error("File not found: " + path);
  if (!fs::is_regular_file(p)) throw std::runtime_error("Path is not a file");
  fs::remove(p);
}

json EditorService::open_files(const json& body) {
  json paths = json::array();
  if (body.is_object()) {
    if (body.contains("paths") && body["paths"].is_array()) paths = body["paths"];
    else if (body.contains("path") && body["path"].is_string()) paths = json::array({body["path"]});
  } else if (body.is_array() && !body.empty() && body[0].is_string()) {
    paths = body;
  }

  if (paths.empty()) {
    return json{{"files", json::array()},
                {"hint",
                 "Native runtime has no file dialog — POST { \"paths\": [\"C:\\\\path\\\\file.txt\"] }."}};
  }

  json files = json::array();
  for (const auto& p : paths) {
    if (!p.is_string()) continue;
    files.push_back(file_entry(p.get<std::string>()));
  }
  return files;
}

json EditorService::save_as(const json& body) {
  const std::string content = body.value("content", "");
  std::string path = body.value("path", body.value("filePath", ""));
  if (path.empty() && body.contains("suggestedPath") && body["suggestedPath"].is_string()) {
    path = body["suggestedPath"].get<std::string>();
  }
  if (path.empty()) {
    return json{{"path", nullptr},
                {"hint",
                 "Native runtime has no save dialog — POST { \"content\": \"...\", \"path\": "
                 "\"C:\\\\path\\\\file.txt\" }."}};
  }
  write_file(path, content);
  return path;
}

std::string EditorService::language_from_path(const std::string& path) {
  const std::string ext = fs::path(path).extension().string();
  if (ext == ".js" || ext == ".mjs" || ext == ".cjs" || ext == ".jsx") return "javascript";
  if (ext == ".ts" || ext == ".tsx") return "typescript";
  if (ext == ".py") return "python";
  if (ext == ".html" || ext == ".htm") return "html";
  if (ext == ".css") return "css";
  if (ext == ".json" || ext == ".jsonl") return "json";
  if (ext == ".md") return "markdown";
  if (ext == ".xml") return "xml";
  if (ext == ".sh" || ext == ".bash") return "shell";
  if (ext == ".ps1") return "powershell";
  if (ext == ".bat" || ext == ".cmd") return "bat";
  if (ext == ".yaml" || ext == ".yml") return "yaml";
  if (ext == ".toml") return "toml";
  if (ext == ".ini") return "ini";
  if (ext == ".txt") return "text";
  return "text";
}

std::string EditorService::title_from_path(const std::string& path) {
  return fs::path(path).filename().string();
}

}  // namespace omega::runtime
