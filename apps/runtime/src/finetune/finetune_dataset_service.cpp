#include "omega/runtime/finetune/finetune_dataset_service.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

json row_from_jsonl_line(const std::string& line) {
  try {
    return json::parse(line);
  } catch (...) {
    return json{{"text", line}};
  }
}

std::vector<json> read_jsonl_lines(const std::string& text) {
  std::vector<json> rows;
  std::istringstream in(text);
  std::string line;
  while (std::getline(in, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t'))
      line.pop_back();
    if (line.empty()) continue;
    rows.push_back(row_from_jsonl_line(line));
  }
  return rows;
}

std::vector<json> read_csv(const std::string& text) {
  std::vector<json> rows;
  std::istringstream in(text);
  std::string line;
  if (!std::getline(in, line)) return rows;
  std::vector<std::string> headers;
  {
    std::istringstream hline(line);
    std::string cell;
    while (std::getline(hline, cell, ',')) {
      std::string h = cell;
      for (auto& c : h) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      headers.push_back(h);
    }
  }
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    std::istringstream lline(line);
    std::string cell;
    json row = json::object();
    size_t i = 0;
    while (std::getline(lline, cell, ',') && i < headers.size()) {
      row[headers[i++]] = cell;
    }
    rows.push_back(row);
  }
  return rows;
}

std::string read_file_text(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::vector<json> load_source_file(const fs::path& path) {
  if (!fs::exists(path)) return {};
  const std::string ext = path.extension().string();
  std::string lower = ext;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  const std::string raw = read_file_text(path);
  if (lower == ".jsonl" || lower == ".ndjson") return read_jsonl_lines(raw);
  if (lower == ".json") {
    json parsed = json::parse(raw);
    if (parsed.is_array()) return parsed.get<std::vector<json>>();
    if (parsed.is_object() && parsed.contains("data") && parsed["data"].is_array()) {
      return parsed["data"].get<std::vector<json>>();
    }
    return {};
  }
  if (lower == ".csv") return read_csv(raw);
  return read_jsonl_lines(raw);
}

std::vector<json> load_sources(const std::vector<std::string>& sources) {
  std::vector<json> rows;
  for (const auto& src : sources) {
    if (src.empty() || !fs::exists(src)) continue;
    if (fs::is_directory(src)) {
      for (const auto& entry : fs::directory_iterator(src)) {
        if (entry.is_regular_file()) {
          const auto part = load_source_file(entry.path());
          rows.insert(rows.end(), part.begin(), part.end());
        }
      }
    } else {
      const auto part = load_source_file(src);
      rows.insert(rows.end(), part.begin(), part.end());
    }
  }
  return rows;
}

std::optional<json> to_alpaca(const json& row) {
  if (row.contains("instruction") && row.contains("output")) {
    return json{{"instruction", row["instruction"]},
                 {"input", row.value("input", "")},
                 {"output", row["output"]}};
  }
  if (row.contains("prompt") && row.contains("response")) {
    return json{{"instruction", row["prompt"]}, {"input", ""}, {"output", row["response"]}};
  }
  if (row.contains("messages") && row["messages"].is_array() && row["messages"].size() >= 2) {
    std::string user;
    std::string asst;
    for (const auto& m : row["messages"]) {
      if (!m.is_object()) continue;
      const std::string role = m.value("role", "");
      if (role == "user") user = m.value("content", "");
      if (role == "assistant") asst = m.value("content", "");
    }
    return json{{"instruction", user}, {"input", ""}, {"output", asst}};
  }
  if (row.contains("text")) {
    const std::string t = row["text"].get<std::string>();
    return json{{"instruction", t}, {"input", ""}, {"output", t}};
  }
  return std::nullopt;
}

std::optional<json> to_chatml(const json& row) {
  if (row.contains("messages") && row["messages"].is_array() && row["messages"].size() >= 2) {
    return json{{"messages", row["messages"]}};
  }
  const auto alpaca = to_alpaca(row);
  if (!alpaca) return std::nullopt;
  const std::string instruction = (*alpaca)["instruction"].get<std::string>();
  const std::string input = (*alpaca)["input"].get<std::string>();
  const std::string user = input.empty() ? instruction : instruction + "\n" + input;
  return json{{"messages", json::array({json{{"role", "user"}, {"content", user}},
                                        json{{"role", "assistant"},
                                             {"content", (*alpaca)["output"]}}})}};
}

std::optional<json> to_vision(const json& row, const std::string& base_dir) {
  const std::string image = row.value("image", "");
  std::string text = row.contains("caption")   ? row["caption"].get<std::string>()
                     : row.contains("output")  ? row["output"].get<std::string>()
                     : row.contains("response") ? row["response"].get<std::string>()
                     : row.contains("text")     ? row["text"].get<std::string>()
                                                : "";
  if (image.empty() || text.empty()) return std::nullopt;
  const std::string resolved = fs::exists(image) ? image : (fs::path(base_dir) / image).string();
  return json{{"image", resolved}, {"text", text}};
}

std::optional<json> to_text_to_image(const json& row, const std::string& base_dir) {
  std::string prompt = row.contains("prompt")      ? row["prompt"].get<std::string>()
                       : row.contains("instruction") ? row["instruction"].get<std::string>()
                       : row.contains("text")        ? row["text"].get<std::string>()
                                                     : "";
  const std::string image = row.value("image", "");
  if (prompt.empty() || image.empty()) return std::nullopt;
  const std::string resolved = fs::exists(image) ? image : (fs::path(base_dir) / image).string();
  return json{{"prompt", prompt}, {"image", resolved}};
}

std::string short_id() { return random_uuid().substr(0, 8); }

}  // namespace

FinetuneDatasetService::FinetuneDatasetService(ProfileContext& profile) : profile_(profile) {}

std::string FinetuneDatasetService::datasets_root() const {
  const fs::path dir = fs::path(profile_.profile_home()) / "finetune" / "datasets";
  fs::create_directories(dir);
  return dir.string();
}

std::string FinetuneDatasetService::presets_path() const {
  const fs::path dir = fs::path(profile_.profile_home()) / "finetune";
  fs::create_directories(dir);
  return (dir / "dataset-presets.json").string();
}

json FinetuneDatasetService::load_presets() const {
  const fs::path path = presets_path();
  if (!fs::exists(path)) return json::array();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void FinetuneDatasetService::persist_presets(const json& items) const {
  std::ofstream out(presets_path());
  out << items.dump(2);
}

json FinetuneDatasetService::list_prepared() const {
  json out = json::array();
  const fs::path root = datasets_root();
  if (!fs::exists(root)) return out;
  for (const auto& entry : fs::directory_iterator(root)) {
    if (!entry.is_directory()) continue;
    const fs::path train = entry.path() / "train.jsonl";
    if (!fs::exists(train)) continue;
    const auto lines = read_jsonl_lines(read_file_text(train));
    const auto ftime = fs::last_write_time(train);
    const auto sctp = std::chrono::time_point_cast<std::chrono::milliseconds>(
        ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now());
    const int64_t created = sctp.time_since_epoch().count();
    out.push_back(json{{"id", entry.path().filename().string()},
                       {"name", "Prepared " + entry.path().filename().string()},
                       {"trainPath", train.string()},
                       {"sampleCount", lines.size()},
                       {"createdAt", created}});
  }
  std::sort(out.begin(), out.end(), [](const json& a, const json& b) {
    return a.value("createdAt", 0) > b.value("createdAt", 0);
  });
  return out;
}

json FinetuneDatasetService::list_presets() const {
  json items = load_presets();
  json normalized = json::array();
  for (const auto& row : items) {
    if (!row.is_object()) continue;
    json preset = row;
    if (!preset.contains("sources") || !preset["sources"].is_array()) {
      preset["sources"] = json::array();
    }
    normalized.push_back(preset);
  }
  std::sort(normalized.begin(), normalized.end(), [](const json& a, const json& b) {
    return a.value("createdAt", 0) > b.value("createdAt", 0);
  });
  return normalized;
}

json FinetuneDatasetService::save_preset(const json& input) {
  json items = load_presets();
  std::string name = input.value("name", "");
  while (!name.empty() && (name.front() == ' ' || name.front() == '\t')) name.erase(name.begin());
  while (!name.empty() && (name.back() == ' ' || name.back() == '\t')) name.pop_back();
  if (name.empty()) name = "Preset " + std::to_string(items.size() + 1);
  json preset{{"id", short_id()},
              {"name", name},
              {"sources", input.contains("sources") ? input["sources"] : json::array()},
              {"modality", input.value("modality", "instruction")},
              {"format", input.value("format", "auto")},
              {"createdAt", std::chrono::duration_cast<std::chrono::milliseconds>(
                                  std::chrono::system_clock::now().time_since_epoch())
                                  .count()}};
  items.push_back(preset);
  persist_presets(items);
  return preset;
}

void FinetuneDatasetService::delete_preset(const std::string& id) {
  json items = load_presets();
  json next = json::array();
  for (const auto& row : items) {
    if (row.value("id", "") != id) next.push_back(row);
  }
  persist_presets(next);
}

json FinetuneDatasetService::inspect_source(const std::string& path) const {
  const std::string trimmed = path;
  if (trimmed.empty()) {
    return json{{"path", trimmed}, {"exists", false}, {"kind", "missing"}, {"hint", "Empty path"}};
  }
  if (!fs::exists(trimmed)) {
    return json{{"path", trimmed},
                  {"exists", false},
                  {"kind", "missing"},
                  {"hint", "Path not found on disk"}};
  }
  if (fs::is_directory(trimmed)) {
    int file_count = 0;
    for (const auto& entry : fs::directory_iterator(trimmed)) {
      if (entry.is_regular_file()) ++file_count;
    }
    return json{{"path", trimmed},
                {"exists", true},
                {"kind", "directory"},
                {"sizeBytes", 0},
                {"estimatedRows", file_count},
                {"hint", std::to_string(file_count) + " files in folder"}};
  }
  const std::string ext = fs::path(trimmed).extension().string();
  std::optional<int> estimated;
  std::string lower = ext;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (lower == ".jsonl" || lower == ".ndjson" || lower == ".csv" || lower == ".txt") {
    try {
      const std::string raw = read_file_text(trimmed);
      if (lower == ".csv") {
        const int lines = static_cast<int>(
            std::count(raw.begin(), raw.end(), '\n') + (raw.empty() ? 0 : 1));
        estimated = std::max(0, lines - 1);
      } else {
        estimated = static_cast<int>(read_jsonl_lines(raw).size());
      }
    } catch (...) {
    }
  }
  json out{{"path", trimmed},
           {"exists", true},
           {"kind", "file"},
           {"sizeBytes", static_cast<int64_t>(fs::file_size(trimmed))},
           {"hint", ext.empty() ? "file" : ext + " file"}};
  if (!ext.empty()) out["extension"] = ext;
  if (estimated) out["estimatedRows"] = *estimated;
  return out;
}

json FinetuneDatasetService::pick_sources(const json& body) const {
  if (body.is_object() && body.contains("sources") && body["sources"].is_array()) {
    return json{{"paths", body["sources"]}};
  }
  return json{{"paths", json::array()},
              {"hint",
               "Native runtime has no file dialog — pass source paths in prepareDataset or POST "
               "sources here."}};
}

bool FinetuneDatasetService::delete_prepared(const std::string& id) {
  const fs::path dir = fs::path(datasets_root()) / id;
  if (!fs::exists(dir)) return false;
  fs::remove_all(dir);
  return true;
}

json FinetuneDatasetService::prepare_dataset(const json& req) {
  if (!req.contains("sources") || !req["sources"].is_array() || req["sources"].empty()) {
    throw std::runtime_error("sources required");
  }
  std::vector<std::string> sources;
  for (const auto& s : req["sources"]) {
    if (s.is_string()) sources.push_back(s.get<std::string>());
  }
  const std::string modality = req.value("modality", "instruction");
  const std::vector<json> rows = load_sources(sources);
  if (rows.empty()) throw std::runtime_error("No training samples found in selected paths");

  const fs::path out_dir = fs::path(datasets_root()) / short_id();
  fs::create_directories(out_dir);
  const fs::path train_path = out_dir / "train.jsonl";

  std::string base_dir = out_dir.string();
  if (!sources.empty()) {
    if (fs::is_directory(sources[0])) {
      base_dir = sources[0];
    } else {
      base_dir = fs::path(sources[0]).parent_path().string();
    }
  }

  std::vector<std::string> lines;
  for (const auto& row : rows) {
    std::optional<json> item;
    if (modality == "conversational" || modality == "chatml") {
      item = to_chatml(row);
    } else if (modality == "image_to_text") {
      item = to_vision(row, base_dir);
    } else if (modality == "text_to_image") {
      item = to_text_to_image(row, base_dir);
    } else {
      item = to_alpaca(row);
    }
    if (item) lines.push_back(item->dump());
  }

  if (lines.empty()) {
    throw std::runtime_error("Could not map any rows to modality \"" + modality +
                             "\". Check column names.");
  }

  {
    std::ofstream out(train_path);
    for (size_t i = 0; i < lines.size(); ++i) {
      out << lines[i];
      if (i + 1 < lines.size()) out << '\n';
    }
    out << '\n';
  }

  std::string preview;
  for (size_t i = 0; i < std::min<size_t>(3, lines.size()); ++i) {
    if (i) preview += '\n';
    preview += lines[i];
  }

  return json{{"trainPath", train_path.string()},
              {"sampleCount", lines.size()},
              {"preview", preview}};
}

}  // namespace omega::runtime
