#include "omega/runtime/models/model_download_service.hpp"

#include "omega/runtime/net/https_client.hpp"
#include "omega/runtime/paths.hpp"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <climits>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <stdexcept>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::mutex g_download_mu;
std::map<std::string, std::shared_ptr<std::atomic<bool>>> g_cancel_flags;
std::set<std::string> g_active_jobs;

std::string job_key(const std::string& repo, const std::string& filename) {
  return repo + "::" + filename;
}

std::string sanitize_model_folder(const std::string& name) {
  std::string out;
  out.reserve(name.size());
  for (char c : name) {
    if (c == '<' || c == '>' || c == ':' || c == '"' || c == '|' || c == '?' || c == '*' ||
        c == '\\')
      out.push_back('_');
    else
      out.push_back(c);
  }
  while (!out.empty() && out.front() == ' ') out.erase(out.begin());
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out.empty() ? "model" : out;
}

std::string model_folder_from_repo(const std::string& repo) {
  const size_t slash = repo.rfind('/');
  const std::string leaf = slash == std::string::npos ? repo : repo.substr(slash + 1);
  return sanitize_model_folder(leaf);
}

std::string encode_path_segments(const std::string& path) {
  std::ostringstream out;
  std::istringstream in(path);
  std::string part;
  bool first = true;
  while (std::getline(in, part, '/')) {
    if (!first) out << '/';
    first = false;
    for (unsigned char c : part) {
      if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~')
        out << static_cast<char>(c);
      else
        out << '%' << std::uppercase << std::hex << ((c >> 4) & 0xF) << (c & 0xF) << std::nouppercase
            << std::dec;
    }
  }
  return out.str();
}

bool allowed_download_ext(const std::string& filename) {
  static const std::regex re(
      R"(\.(gguf|safetensors|bin|pt|pth|onnx_data|onnx\.data|onnx|exl2|npz|json|model|txt|jinja)$)",
      std::regex_constants::icase);
  return std::regex_search(filename, re);
}

bool allowed_adapter_ext(const std::string& filename) {
  static const std::regex re(R"(\.(gguf|safetensors)$)", std::regex_constants::icase);
  return std::regex_search(filename, re);
}

json progress_payload(const std::string& repo, const std::string& filename,
                      const std::string& status, uint64_t done = 0, uint64_t total = 0,
                      double percent = 0, uint64_t speed = 0) {
  return json{{"repo", repo},
              {"filename", filename},
              {"bytes_done", done},
              {"bytes_total", total},
              {"percent", percent},
              {"speed_bps", speed},
              {"status", status}};
}

std::string models_root(ConfigStore& config) {
  const json cfg = config.load();
  if (cfg.contains("modelsDir") && cfg["modelsDir"].is_string()) {
    const std::string dir = cfg["modelsDir"].get<std::string>();
    if (!dir.empty()) return dir;
  }
  return models_dir();
}

}  // namespace

ModelDownloadService::ModelDownloadService(ConfigStore& config, HfClient& hf, EventBus& events)
    : config_(config), hf_(hf), events_(events) {}

std::string ModelDownloadService::dest_path_for_repo_file(const std::string& repo,
                                                          const std::string& filename) const {
  const fs::path root = fs::path(models_root(config_)) / model_folder_from_repo(repo);
  fs::path dest = root;
  std::istringstream in(filename);
  std::string part;
  while (std::getline(in, part, '/')) {
    if (!part.empty()) dest /= part;
  }
  const auto root_norm = root.lexically_normal().string();
  const auto dest_norm = dest.lexically_normal().string();
  if (dest_norm.size() < root_norm.size() || dest_norm.compare(0, root_norm.size(), root_norm) != 0) {
    throw std::runtime_error("invalid download path");
  }
  return dest.string();
}

std::string ModelDownloadService::adapter_dest_path(const std::string& repo,
                                                    const std::string& filename) const {
  const std::string safe = std::regex_replace(repo, std::regex("/"), "__");
  fs::path dest = fs::path(omega_home()) / "adapters" / safe;
  std::istringstream in(filename);
  std::string part;
  while (std::getline(in, part, '/')) {
    if (!part.empty()) dest /= part;
  }
  return dest.string();
}

void ModelDownloadService::write_repo_sidecar(const std::string& repo,
                                              const std::string& filename) const {
  const fs::path pack = fs::path(dest_path_for_repo_file(repo, filename)).parent_path();
  std::error_code ec;
  fs::create_directories(pack, ec);
  const fs::path sidecar = pack / ".omega-hf-repo.json";
  std::ofstream out(sidecar);
  if (out) out << json{{"repo_id", repo}}.dump(2);
}

void ModelDownloadService::emit_inventory_changed() const {
  events_.publish("omega:models:inventoryChanged", json::object());
}

std::string ModelDownloadService::download_to_path(const std::string& repo,
                                                  const std::string& filename,
                                                  const std::string& dest_path,
                                                  ProgressFn on_progress) {
  if (repo.empty() || filename.empty()) throw std::runtime_error("repo and filename are required");
  if (!allowed_download_ext(filename) && dest_path.find("adapters") == std::string::npos) {
    throw std::runtime_error("unsupported file extension: " + filename);
  }

  const json access = hf_.check_repo_access(repo);
  if (!access.value("ok", false)) {
    if (access.value("gated", false)) {
      throw std::runtime_error("Hugging Face repo requires access — add HF token in config");
    }
    if (access.value("status", 0) == 404) {
      throw std::runtime_error("Model repo not found (404): " + repo);
    }
  }

  const std::string key = job_key(repo, filename);
  {
    std::lock_guard lock(g_download_mu);
    if (g_active_jobs.count(key)) throw std::runtime_error("download already in progress");
    g_active_jobs.insert(key);
    g_cancel_flags[key] = std::make_shared<std::atomic<bool>>(false);
  }
  auto cancel_flag = g_cancel_flags[key];

  struct JobGuard {
    std::string key;
    ~JobGuard() {
      std::lock_guard lock(g_download_mu);
      g_active_jobs.erase(key);
      g_cancel_flags.erase(key);
    }
  } guard{key};

  auto emit = [&](const json& p) {
    on_progress(p);
    events_.publish("omega:download:progress", p);
  };

  emit(progress_payload(repo, filename, "starting"));

  const std::string url_path = "/" + HfClient::encode_repo(repo) + "/resolve/main/" +
                               encode_path_segments(filename);
  const std::string url = "https://huggingface.co" + url_path;

  https::RequestOptions req;
  req.connection_timeout_sec = 30;
  req.read_timeout_sec = 600;
  req.follow_redirects = true;
  req.headers.emplace("Accept", "*/*");

  const json cfg = config_.load();
  std::string token;
  if (cfg.contains("hfToken") && cfg["hfToken"].is_string()) token = cfg["hfToken"].get<std::string>();
  if (token.empty()) {
    if (const char* hf = std::getenv("HF_TOKEN")) token = hf;
    else if (const char* hub = std::getenv("HUGGING_FACE_HUB_TOKEN")) token = hub;
  }
  if (!token.empty()) req.headers.emplace("Authorization", "Bearer " + token);

  uint64_t offset = 0;
  if (fs::exists(dest_path)) {
    std::error_code ec;
    offset = static_cast<uint64_t>(fs::file_size(dest_path, ec));
  }

  fs::create_directories(fs::path(dest_path).parent_path());

  if (offset > 0) req.headers.emplace("Range", "bytes=" + std::to_string(offset) + "-");

  uint64_t total = 0;
  uint64_t written = 0;
  const auto start = std::chrono::steady_clock::now();
  auto last_emit = start;

  std::ofstream file;
  if (offset > 0)
    file.open(dest_path, std::ios::binary | std::ios::app);
  else
    file.open(dest_path, std::ios::binary | std::ios::trunc);

  if (!file) throw std::runtime_error("failed to open destination: " + dest_path);

  const auto res = https::get_stream(
      url, req,
      [&](const char* data, size_t len) {
        if (cancel_flag->load()) return false;
        file.write(data, static_cast<std::streamsize>(len));
        if (!file) return false;
        written += len;
        const auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_emit).count() >= 200) {
          const double elapsed =
              std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count() / 1000.0;
          const uint64_t done = offset + written;
          const uint64_t speed = elapsed > 0 ? static_cast<uint64_t>(written / elapsed) : 0;
          const double pct = total > 0 ? std::min(100.0, (100.0 * done) / total) : 0.0;
          emit(progress_payload(repo, filename, "downloading", done, total, pct, speed));
          last_emit = now;
        }
        return true;
      },
      [&](uint64_t current, uint64_t t) {
        if (t > 0) total = t + offset;
        else if (current > 0 && total == 0) total = current + offset;
        return !cancel_flag->load();
      });

  file.close();

  if (cancel_flag->load()) {
    emit(progress_payload(repo, filename, "cancelled"));
    throw std::runtime_error("download cancelled");
  }
  if (res.status == 401 || res.status == 403) {
    throw std::runtime_error("Hugging Face access denied — check HF token");
  }
  if (res.status == 404) throw std::runtime_error("file not found on Hugging Face: " + filename);
  if (res.status < 200 || (res.status >= 300 && res.status != 416)) {
    throw std::runtime_error("Hugging Face download failed: HTTP " + std::to_string(res.status));
  }

  const uint64_t done = offset + written;
  if (total == 0) total = done;
  emit(progress_payload(repo, filename, "complete", done, total, 100.0, 0));
  return dest_path;
}

json ModelDownloadService::download(const std::string& repo, const std::string& filename) {
  const std::string dest = dest_path_for_repo_file(repo, filename);
  const std::string path =
      download_to_path(repo, filename, dest, [](const json&) {});
  write_repo_sidecar(repo, filename);
  emit_inventory_changed();
  return json{{"path", path}};
}

json ModelDownloadService::download_bundle(const std::string& repo,
                                           const std::vector<std::string>& paths) {
  if (paths.empty()) throw std::runtime_error("no files to download");
  json downloaded = json::array();
  for (size_t i = 0; i < paths.size(); ++i) {
    const std::string& file = paths[i];
    try {
      const json one = download(repo, file);
      downloaded.push_back(one.value("path", ""));
    } catch (const std::exception& e) {
      if (std::string(e.what()).find("cancelled") != std::string::npos) {
        events_.publish("omega:download:progress", progress_payload(repo, file, "cancelled"));
        continue;
      }
      throw;
    }
  }
  for (const auto& file : paths) {
    try {
      const std::string dest = dest_path_for_repo_file(repo, file);
      std::error_code ec;
      const uint64_t sz = fs::exists(dest, ec) ? static_cast<uint64_t>(fs::file_size(dest, ec)) : 0;
      events_.publish("omega:download:progress",
                      progress_payload(repo, file, "complete", sz, sz > 0 ? sz : sz, 100.0, 0));
    } catch (...) {
    }
  }
  emit_inventory_changed();
  return json{{"paths", paths}, {"downloaded", downloaded}};
}

std::vector<std::string> ModelDownloadService::resolve_required_paths(const json& req) const {
  if (req.contains("paths") && req["paths"].is_array()) {
    std::vector<std::string> out;
    for (const auto& p : req["paths"]) {
      if (p.is_string()) out.push_back(p.get<std::string>());
    }
    return out;
  }

  const std::string repo = req.value("repo", "");
  if (repo.empty()) throw std::runtime_error("repo is required");

  const auto basename_lower = [](const std::string& path) {
    const size_t slash = path.find_last_of("/\\");
    std::string base = slash == std::string::npos ? path : path.substr(slash + 1);
    std::transform(base.begin(), base.end(), base.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return base;
  };

  const auto dirname_of = [](const std::string& path) -> std::string {
    const size_t slash = path.find_last_of("/\\");
    return slash == std::string::npos ? std::string{} : path.substr(0, slash);
  };

  const auto score_genai_pack = [](const std::string& path) -> int {
    std::string lower = path;
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    int score = 0;
    if (lower.find("cpu") != std::string::npos) score += 100;
    if (lower.find("int4") != std::string::npos) score += 50;
    if (lower.find("mobile") != std::string::npos) score += 25;
    if (lower.find("gpu") != std::string::npos || lower.find("cuda") != std::string::npos) score -= 30;
    score -= static_cast<int>(std::count(lower.begin(), lower.end(), '/'));
    return score;
  };

  const auto resolve_onnx_genai_paths = [&](const json& files_array) -> std::vector<std::string> {
    if (!files_array.is_array()) return {};
    static const std::set<std::string> support = {
        "genai_config.json", "config.json",         "tokenizer.json",
        "tokenizer.model",   "tokenizer_config.json", "special_tokens_map.json",
        "vocab.json",        "merges.txt",          "chat_template.jinja",
        "added_tokens.json", "generation_config.json"};
    static const std::vector<std::string> prefer_onnx = {
        "model_q4f16.onnx", "model_q4.onnx", "model_quantized.onnx", "model_fp16.onnx",
        "model.onnx"};

    auto is_onnx_weight = [&](const std::string& path, const std::string& fmt) {
      const std::string base = basename_lower(path);
      if (fmt == "onnx") return true;
      return base.find(".onnx") != std::string::npos;
    };

    auto in_pack_dir = [&](const std::string& path, const std::string& pack_dir) {
      if (pack_dir.empty()) return true;
      const std::string dir = dirname_of(path);
      return dir == pack_dir || path.rfind(pack_dir + "/", 0) == 0;
    };

    std::string genai_config_path;
    int best_genai_score = INT_MIN;
    bool has_genai = false;
    for (const auto& f : files_array) {
      const std::string path = f.value("path", "");
      if (path.empty()) continue;
      if (basename_lower(path) != "genai_config.json") continue;
      has_genai = true;
      const int score = score_genai_pack(path);
      if (score > best_genai_score) {
        best_genai_score = score;
        genai_config_path = path;
      }
    }
    const bool force_onnx = req.value("format", "") == "onnx";
    if (!has_genai && !force_onnx) return {};

    const std::string pack_dir = dirname_of(genai_config_path);

    std::string primary_onnx;
    int64_t primary_size = INT64_MAX;
    for (const auto& prefer : prefer_onnx) {
      for (const auto& f : files_array) {
        const std::string path = f.value("path", "");
        if (path.empty()) continue;
        if (basename_lower(path) != prefer) continue;
        if (!in_pack_dir(path, pack_dir)) continue;
        primary_onnx = path;
        break;
      }
      if (!primary_onnx.empty()) break;
    }
    if (primary_onnx.empty()) {
      for (const auto& f : files_array) {
        const std::string path = f.value("path", "");
        const std::string base = basename_lower(path);
        if (!is_onnx_weight(path, f.value("format", ""))) continue;
        if (base.find(".onnx_data") != std::string::npos) continue;
        if (!in_pack_dir(path, pack_dir)) continue;
        const int64_t sz = f.value("size", 0);
        if (sz < primary_size) {
          primary_size = sz;
          primary_onnx = path;
        }
      }
    }

    std::vector<std::string> out;
    std::set<std::string> seen;
    auto add = [&](const std::string& path) {
      if (path.empty() || !seen.insert(path).second) return;
      out.push_back(path);
    };

    if (!genai_config_path.empty()) add(genai_config_path);

    if (!primary_onnx.empty()) {
      add(primary_onnx);
      const std::string stem = primary_onnx.size() > 5 &&
                                       primary_onnx.substr(primary_onnx.size() - 5) == ".onnx"
                                   ? primary_onnx.substr(0, primary_onnx.size() - 5)
                                   : primary_onnx;
      for (const auto& f : files_array) {
        const std::string path = f.value("path", "");
        if (path == primary_onnx) continue;
        if (path.rfind(stem, 0) != 0) continue;
        if (basename_lower(path).find(".onnx_data") != std::string::npos ||
            basename_lower(path).find(".onnx.data") != std::string::npos)
          add(path);
      }
    } else if (has_genai) {
      for (const auto& f : files_array) {
        const std::string path = f.value("path", "");
        if (!is_onnx_weight(path, f.value("format", ""))) continue;
        if (!in_pack_dir(path, pack_dir)) continue;
        add(path);
      }
    } else {
      return {};
    }

    for (const auto& f : files_array) {
      const std::string path = f.value("path", "");
      if (path.empty()) continue;
      if (!support.count(basename_lower(path))) continue;
      if (!in_pack_dir(path, pack_dir)) continue;
      add(path);
    }

    return out.empty() ? std::vector<std::string>{} : out;
  };

  const std::string primary = req.value("primaryPath", "");
  const std::string vision = req.value("visionPath", "");

  std::vector<std::string> gguf_paths;
  std::vector<std::string> weight_paths;

  if (req.contains("files") && req["files"].is_array()) {
    const auto onnx_paths = resolve_onnx_genai_paths(req["files"]);
    if (!onnx_paths.empty()) return onnx_paths;

    for (const auto& f : req["files"]) {
      const std::string path = f.value("path", "");
      if (path.empty()) continue;
      const std::string fmt = f.value("format", "");
      if (fmt == "gguf") gguf_paths.push_back(path);
      if (fmt == "safetensors" || fmt == "awq" || fmt == "gptq" || fmt == "pytorch")
        weight_paths.push_back(path);
    }
  }

  std::set<std::string> chosen;
  if (!gguf_paths.empty() && (weight_paths.empty() || !primary.empty())) {
    if (!primary.empty()) chosen.insert(primary);
    else chosen.insert(gguf_paths.front());
    if (!vision.empty()) chosen.insert(vision);
    else {
      for (const auto& p : gguf_paths) {
        if (p.find("mmproj") != std::string::npos || p.find("vision") != std::string::npos)
          chosen.insert(p);
      }
    }
    return std::vector<std::string>(chosen.begin(), chosen.end());
  }

  if (!weight_paths.empty()) {
    if (!primary.empty()) chosen.insert(primary);
    else chosen.insert(weight_paths.front());
    return std::vector<std::string>(chosen.begin(), chosen.end());
  }

  const json listed = hf_.repo_file_paths(repo);
  std::vector<std::string> out;
  if (listed.is_array()) {
    for (const auto& p : listed) {
      if (p.is_string()) out.push_back(p.get<std::string>());
    }
  }
  if (out.empty()) throw std::runtime_error("Could not determine required files for this model.");
  return {out.front()};
}

json ModelDownloadService::download_required(const json& req) {
  const std::string repo = req.value("repo", "");
  if (repo.empty()) throw std::runtime_error("repo is required");
  const auto paths = resolve_required_paths(req);
  return download_bundle(repo, paths);
}

json ModelDownloadService::cancel(const std::string& repo, const std::string& filename) {
  const std::string key = job_key(repo, filename);
  std::lock_guard lock(g_download_mu);
  const auto it = g_cancel_flags.find(key);
  if (it != g_cancel_flags.end()) it->second->store(true);
  const json p = progress_payload(repo, filename, "cancelled");
  events_.publish("omega:download:progress", p);
  return json{{"ok", true}};
}

json ModelDownloadService::download_adapter(const std::string& repo, const std::string& filename) {
  if (!allowed_adapter_ext(filename)) throw std::runtime_error("unsupported adapter file");
  const std::string dest = adapter_dest_path(repo, filename);
  const std::string path = download_to_path(repo, filename, dest, [](const json&) {});
  return json{{"path", path}};
}

}  // namespace omega::runtime
