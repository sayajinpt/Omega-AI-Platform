#include "omega/engine/model_registry.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <system_error>

#include "omega/engine/runtime/thread_pool.hpp"

namespace fs = std::filesystem;

namespace omega::engine {

namespace {

std::string to_lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string pack_id_for_path(const fs::path& file_path, const fs::path& models_dir) {
  std::error_code ec;
  const fs::path parent = file_path.parent_path();
  if (parent == models_dir) {
    return file_path.stem().string();
  }
  const fs::path rel = fs::relative(parent, models_dir, ec);
  if (ec || rel.empty() || rel == ".") {
    return file_path.stem().string();
  }
  const std::string rel_str = rel.generic_string();
  const auto slash = rel_str.find('/');
  return slash == std::string::npos ? rel_str : rel_str.substr(0, slash);
}

int quant_preference_score(const std::string& filename) {
  const std::string lower = to_lower(filename);
  if (lower.find("q4_k_m") != std::string::npos) return 100;
  if (lower.find("q5_k_m") != std::string::npos) return 90;
  if (lower.find("q4_k_s") != std::string::npos) return 80;
  if (lower.find("q4_0") != std::string::npos) return 70;
  if (lower.find("q5_0") != std::string::npos) return 60;
  if (lower.find("q6_k") != std::string::npos) return 50;
  if (lower.find("q8_0") != std::string::npos) return 40;
  return 0;
}

bool prefer_primary_gguf(const ModelRecord& candidate, const std::string& candidate_name,
                         const ModelRecord& incumbent, const std::string& incumbent_name) {
  const bool cand_aux = ModelRegistry::is_auxiliary_gguf(candidate_name);
  const bool inc_aux = ModelRegistry::is_auxiliary_gguf(incumbent_name);
  if (cand_aux != inc_aux) return !cand_aux;

  const int cand_score = quant_preference_score(candidate_name);
  const int inc_score = quant_preference_score(incumbent_name);
  if (cand_score != inc_score) return cand_score > inc_score;

  return candidate.size_bytes > incumbent.size_bytes;
}

}  // namespace

ModelRegistry::ModelRegistry(std::string dir) : dir_(std::move(dir)) { rescan(); }

bool ModelRegistry::is_auxiliary_gguf(const std::string& filename) {
  const std::string lower = to_lower(filename);
  return lower.find("mmproj") != std::string::npos || lower.find("clip") != std::string::npos ||
         lower.find("-vision") != std::string::npos;
}

ModelRecord ModelRegistry::build_record(const std::string& path, const std::string& pack_id) {
  ModelRecord rec;
  rec.path = path;
  rec.id = pack_id;
  std::error_code ec;
  const auto sz = fs::file_size(path, ec);
  if (!ec) rec.size_bytes = static_cast<int64_t>(sz);
  return rec;
}

void ModelRegistry::rescan() {
  std::map<std::string, ModelRecord> entries;
  std::map<std::string, std::string> entry_names;
  std::error_code ec;
  const fs::path root(dir_);
  if (!fs::exists(root, ec)) {
    fs::create_directories(root, ec);
  }
  if (!fs::is_directory(root, ec)) {
    std::lock_guard lock(mutex_);
    cache_.clear();
    return;
  }
  for (const auto& entry : fs::recursive_directory_iterator(
           root, fs::directory_options::skip_permission_denied, ec)) {
    if (ec) break;
    if (!entry.is_regular_file(ec)) continue;
    const auto path = entry.path();
    const std::string ext = to_lower(path.extension().string());
    if (ext != ".gguf") continue;
    const std::string filename = path.filename().string();
    if (is_auxiliary_gguf(filename)) continue;
    const auto full = path.string();
    const std::string pack_id = pack_id_for_path(path, root);
    auto rec = build_record(full, pack_id);
    const auto it = entries.find(pack_id);
    if (it == entries.end()) {
      entries[pack_id] = std::move(rec);
      entry_names[pack_id] = filename;
      continue;
    }
    if (prefer_primary_gguf(rec, filename, it->second, entry_names[pack_id])) {
      entries[pack_id] = std::move(rec);
      entry_names[pack_id] = filename;
    }
  }
  std::lock_guard lock(mutex_);
  cache_ = std::move(entries);
}

void ModelRegistry::schedule_rescan(ThreadPool& pool) {
  pool.submit([this]() { rescan(); });
}

std::vector<ModelRecord> ModelRegistry::list() const {
  std::lock_guard lock(mutex_);
  std::vector<ModelRecord> out;
  out.reserve(cache_.size());
  for (const auto& kv : cache_) out.push_back(kv.second);
  std::sort(out.begin(), out.end(),
            [](const ModelRecord& a, const ModelRecord& b) { return a.id < b.id; });
  return out;
}

bool ModelRegistry::get(const std::string& id, ModelRecord& out) const {
  std::lock_guard lock(mutex_);
  const auto lookup = [&](const std::string& key) -> const ModelRecord* {
    const auto it = cache_.find(key);
    return it != cache_.end() ? &it->second : nullptr;
  };
  if (const ModelRecord* hit = lookup(id)) {
    out = *hit;
    return true;
  }
  std::string stem = id;
  if (stem.size() > 5 && to_lower(stem.substr(stem.size() - 5)) == ".gguf") {
    stem = stem.substr(0, stem.size() - 5);
    if (const ModelRecord* hit = lookup(stem)) {
      out = *hit;
      return true;
    }
  }
  for (const auto& kv : cache_) {
    const fs::path p(kv.second.path);
    const std::string file_stem = p.stem().string();
    if (file_stem == id || file_stem == stem) {
      out = kv.second;
      return true;
    }
  }
  return false;
}

bool ModelRegistry::remove(const std::string& id, std::string& error) {
  ModelRecord rec;
  {
    std::lock_guard lock(mutex_);
    const auto it = cache_.find(id);
    if (it == cache_.end()) {
      error = "model not found: " + id;
      return false;
    }
    rec = it->second;
    cache_.erase(it);
  }
  std::error_code ec;
  fs::remove(rec.path, ec);
  if (ec && ec != std::errc::no_such_file_or_directory) {
    error = "failed to delete file: " + ec.message();
    return false;
  }
  return true;
}

}  // namespace omega::engine
