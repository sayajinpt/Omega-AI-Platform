#include "omega/runtime/inference/sidecar_model_inventory.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <set>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string to_lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

std::string pack_id_for_dir(const fs::path& dir, const fs::path& models_root) {
  std::error_code ec;
  const fs::path rel = fs::relative(dir, models_root, ec);
  if (ec || rel.empty() || rel == ".") return dir.filename().string();
  const std::string rel_str = rel.generic_string();
  const auto slash = rel_str.find('/');
  return slash == std::string::npos ? rel_str : rel_str.substr(0, slash);
}

int64_t dir_size_bytes(const fs::path& dir) {
  int64_t total = 0;
  std::error_code ec;
  for (const auto& entry :
       fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
    if (ec) break;
    if (!entry.is_regular_file(ec)) continue;
    total += static_cast<int64_t>(entry.file_size(ec));
  }
  return total;
}

std::string detect_format_in_dir(const fs::path& dir) {
  std::error_code ec;
  if (fs::exists(dir / "genai_config.json", ec)) return "onnx";
  for (const auto& entry :
       fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
    if (ec) break;
    if (!entry.is_regular_file(ec)) continue;
    if (entry.path().filename().string() == "genai_config.json") return "onnx";
  }
  if (fs::exists(dir / "measurement.json", ec)) return "exl2";
  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    if (ec) break;
    if (!entry.is_regular_file(ec)) continue;
    const std::string ext = to_lower(entry.path().extension().string());
    if (ext == ".exl2") return "exl2";
  }
  if (fs::exists(dir / "config.json", ec)) {
    for (const auto& entry : fs::recursive_directory_iterator(
             dir, fs::directory_options::skip_permission_denied, ec)) {
      if (ec) break;
      if (!entry.is_regular_file(ec)) continue;
      const std::string p = to_lower(entry.path().string());
      if (p.find(".onnx") != std::string::npos) return "onnx";
    }
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
      if (ec) break;
      if (!entry.is_regular_file(ec)) continue;
      if (to_lower(entry.path().extension().string()) == ".exl2") return "exl2";
    }
  }
  return {};
}

bool skip_scan_dir_name(const std::string& name) {
  const std::string lower = to_lower(name);
  return lower == "generation-models" || lower == "adapters" || lower.starts_with(".");
}

void try_add_pack(const fs::path& dir, const fs::path& models_root, json& out,
                  std::set<std::string>& seen_ids) {
  const std::string fmt = detect_format_in_dir(dir);
  if (fmt.empty()) return;
  const std::string id = pack_id_for_dir(dir, models_root);
  if (id.empty() || seen_ids.count(id)) return;
  seen_ids.insert(id);
  json row;
  row["id"] = id;
  row["path"] = dir.string();
  row["size_bytes"] = dir_size_bytes(dir);
  row["format"] = fmt;
  row["inferenceBackend"] = fmt;
  row["nativeSupported"] = true;
  row["metadata"] = json::object();
  const fs::path sidecar = dir / ".omega-hf-repo.json";
  if (fs::exists(sidecar)) {
    try {
      std::ifstream in(sidecar);
      const json meta = json::parse(in);
      if (meta.contains("repo_id") && meta["repo_id"].is_string()) {
        row["hfRepo"] = meta["repo_id"];
      }
    } catch (...) {
    }
  }
  out.push_back(std::move(row));
}

}  // namespace

json scan_sidecar_models(const std::string& models_dir) {
  json out = json::array();
  std::error_code ec;
  const fs::path root(models_dir);
  if (!fs::is_directory(root, ec)) return out;

  std::set<std::string> seen_ids;
  for (const auto& entry : fs::directory_iterator(root, ec)) {
    if (ec) break;
    if (!entry.is_directory(ec)) continue;
    const std::string name = entry.path().filename().string();
    if (skip_scan_dir_name(name)) continue;
    try_add_pack(entry.path(), root, out, seen_ids);
  }

  for (const auto& entry :
       fs::recursive_directory_iterator(root, fs::directory_options::skip_permission_denied, ec)) {
    if (ec) break;
    if (!entry.is_directory(ec)) continue;
    const auto dir = entry.path();
    if (dir == root) continue;
    if (skip_scan_dir_name(dir.filename().string())) continue;
    if (!fs::exists(dir / "genai_config.json", ec) && !fs::exists(dir / "measurement.json", ec)) {
      bool has_exl2 = false;
      bool has_onnx = false;
      for (const auto& f : fs::recursive_directory_iterator(
               dir, fs::directory_options::skip_permission_denied, ec)) {
        if (ec) break;
        if (!f.is_regular_file(ec)) continue;
        const std::string p = to_lower(f.path().string());
        if (p.find(".exl2") != std::string::npos) has_exl2 = true;
        if (p.find(".onnx") != std::string::npos) has_onnx = true;
      }
      if (!has_exl2 && !(has_onnx && fs::exists(dir / "config.json", ec))) continue;
    }
    try_add_pack(dir, root, out, seen_ids);
  }

  return out;
}

std::string sidecar_model_directory(const std::string& models_dir, const std::string& model_id) {
  if (model_id.empty()) return {};
  const json models = scan_sidecar_models(models_dir);
  if (!models.is_array()) return {};
  for (const auto& m : models) {
    if (!m.is_object()) continue;
    if (m.value("id", "") == model_id) return m.value("path", "");
  }
  const fs::path direct = fs::path(models_dir) / model_id;
  std::error_code ec;
  if (fs::is_directory(direct, ec) && !detect_format_in_dir(direct).empty()) {
    return direct.string();
  }
  return {};
}

std::string detect_sidecar_format(const std::string& model_dir) {
  return detect_format_in_dir(fs::path(model_dir));
}

bool is_sidecar_inference_backend(const std::string& backend) {
  const std::string lower = to_lower(backend);
  return lower == "onnx" || lower == "exl2";
}

}  // namespace omega::runtime
