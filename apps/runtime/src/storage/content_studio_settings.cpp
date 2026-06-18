#include "omega/runtime/storage/content_studio_settings.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/python/venv_setup.hpp"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <optional>
#include <set>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

ContentStudioSettings::ContentStudioSettings(ProfileContext& profile) : profile_(profile) {}

std::string ContentStudioSettings::credentials_path() const {
  return (fs::path(profile_.profile_home()) / "content-studio-credentials.json").string();
}

std::string ContentStudioSettings::generation_path() const {
  return (fs::path(profile_.profile_home()) / "content-studio-generation.json").string();
}

json ContentStudioSettings::load_credentials() const {
  const fs::path path = credentials_path();
  if (!fs::exists(path)) return json::object();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_object() ? root : json::object();
  } catch (...) {
    return json::object();
  }
}

json ContentStudioSettings::save_credentials(const json& creds) {
  const fs::path path = credentials_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << creds.dump(2);
  return creds;
}

json ContentStudioSettings::credentials_to_api_payload(const json& c) const {
  json out = json::object();
  const auto set = [&](const char* key, const char* env) {
    if (c.contains(key) && c[key].is_string() && !c[key].get<std::string>().empty()) {
      out[env] = c[key];
    }
  };
  set("youtubeClientId", "YOUTUBE_CLIENT_ID");
  set("youtubeClientSecret", "YOUTUBE_CLIENT_SECRET");
  set("youtubeRefreshToken", "YOUTUBE_REFRESH_TOKEN");
  set("youtubeUploadPrivacy", "YOUTUBE_UPLOAD_PRIVACY");
  set("metaAppId", "META_APP_ID");
  set("metaAppSecret", "META_APP_SECRET");
  set("metaAccessToken", "META_ACCESS_TOKEN");
  set("metaPageId", "META_PAGE_ID");
  set("instagramBusinessAccountId", "INSTAGRAM_BUSINESS_ACCOUNT_ID");
  set("tiktokClientKey", "TIKTOK_CLIENT_KEY");
  set("tiktokClientSecret", "TIKTOK_CLIENT_SECRET");
  set("tiktokAccessToken", "TIKTOK_ACCESS_TOKEN");
  set("xApiKey", "X_API_KEY");
  set("xApiSecret", "X_API_SECRET");
  set("xAccessToken", "X_ACCESS_TOKEN");
  set("xAccessTokenSecret", "X_ACCESS_TOKEN_SECRET");
  set("linkedinClientId", "LINKEDIN_CLIENT_ID");
  set("linkedinClientSecret", "LINKEDIN_CLIENT_SECRET");
  set("linkedinAccessToken", "LINKEDIN_ACCESS_TOKEN");
  if (c.contains("youtubeOAuthRedirectUri") && c["youtubeOAuthRedirectUri"].is_string()) {
    out["YOUTUBE_OAUTH_REDIRECT_URI"] = c["youtubeOAuthRedirectUri"];
  }
  return out;
}

json ContentStudioSettings::generation_defaults() {
  return json{{"scriptMode", "agent_orchestrated"},
              {"preferNativeMedia", false},
              {"ttsRepoId", ""},
              {"imageRepoId", ""},
              {"videoRepoId", ""},
              {"omegaModelId", ""},
              {"reloadChatModelAfterJob", false},
              {"imageVramMode", "all_gpu"},
              {"imageStepsByRepo", json::object()},
              {"videoStepsByRepo", json::object()},
              {"imageSizeByRepo", json::object()},
              {"videoSizeByRepo", json::object()},
              {"imageAdapters", json::array()}};
}

namespace {

void merge_omega_tools_into_generation(json& gen, const json& app_config) {
  if (!app_config.is_object()) return;
  const json tools = app_config.value("omegaTools", json::object());
  if (!tools.is_object()) return;

  auto copy_repo = [&](const char* tool_key, const char* gen_key) {
    if (!tools.contains(tool_key) || !tools[tool_key].is_string()) return;
    const std::string v = tools[tool_key].get<std::string>();
    if (!v.empty()) gen[gen_key] = v;
  };
  auto copy_steps_map = [&](const char* tool_key, const char* gen_key) {
    if (!tools.contains(tool_key) || !tools[tool_key].is_object()) return;
    gen[gen_key] = tools[tool_key];
  };

  copy_repo("contentStudioTtsRepoId", "ttsRepoId");
  copy_repo("contentStudioImageRepoId", "imageRepoId");
  copy_repo("contentStudioVideoRepoId", "videoRepoId");
  copy_steps_map("contentStudioImageStepsByRepo", "imageStepsByRepo");
  copy_steps_map("contentStudioVideoStepsByRepo", "videoStepsByRepo");
  if (tools.contains("contentStudioImageVramMode") && tools["contentStudioImageVramMode"].is_string()) {
    gen["imageVramMode"] = tools["contentStudioImageVramMode"];
  }
  if (tools.contains("contentStudioImageSizeByRepo") && tools["contentStudioImageSizeByRepo"].is_object()) {
    gen["imageSizeByRepo"] = tools["contentStudioImageSizeByRepo"];
  }
  if (tools.contains("contentStudioVideoSizeByRepo") && tools["contentStudioVideoSizeByRepo"].is_object()) {
    gen["videoSizeByRepo"] = tools["contentStudioVideoSizeByRepo"];
  }
  if (tools.contains("contentStudioImageAdapters") && tools["contentStudioImageAdapters"].is_array()) {
    gen["imageAdapters"] = tools["contentStudioImageAdapters"];
  }
}

}  // namespace

json ContentStudioSettings::sync_generation_from_app_config(const json& app_config) {
  const fs::path path = generation_path();
  json gen = generation_defaults();
  if (fs::exists(path)) {
    try {
      std::ifstream in(path);
      const json root = json::parse(in);
      if (root.is_object()) {
        for (auto it = root.begin(); it != root.end(); ++it) gen[it.key()] = it.value();
      }
    } catch (...) {
    }
  }
  merge_omega_tools_into_generation(gen, app_config);
  return save_generation(gen);
}

json ContentStudioSettings::load_generation() const {
  const fs::path path = generation_path();
  json base = generation_defaults();
  if (fs::exists(path)) {
    try {
      std::ifstream in(path);
      json root = json::parse(in);
      if (root.is_object()) {
        for (auto it = root.begin(); it != root.end(); ++it) base[it.key()] = it.value();
      }
    } catch (...) {
    }
  }
  try {
    const fs::path cfg_path = config_path();
    if (fs::exists(cfg_path)) {
      std::ifstream in(cfg_path);
      const json cfg = json::parse(in);
      merge_omega_tools_into_generation(base, cfg);
    }
  } catch (...) {
  }
  return base;
}

json ContentStudioSettings::save_generation(const json& settings) {
  json merged = load_generation();
  if (settings.is_object()) {
    for (auto it = settings.begin(); it != settings.end(); ++it) merged[it.key()] = it.value();
  }
  const fs::path path = generation_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << merged.dump(2);
  return merged;
}

namespace {

std::string read_config_model_role_pin(const char* key) {
  const fs::path path = config_path();
  if (!fs::exists(path)) return {};
  try {
    std::ifstream in(path);
    const json cfg = json::parse(in);
    if (!cfg.is_object()) return {};
    const json tools = cfg.value("omegaTools", json::object());
    if (!tools.is_object()) return {};
    if (!tools.contains(key) || !tools[key].is_string()) return {};
    return tools[key].get<std::string>();
  } catch (...) {
    return {};
  }
}

}  // namespace

json ContentStudioSettings::generation_to_api_payload(const json& g) const {
  const json catalog = local_generation_catalog();
  const std::string default_tts = catalog["defaults"].value("tts", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice");
  const std::string default_image = catalog["defaults"].value("image", "cutycat2000/InterDiffusion-Nano");
  const std::string default_video = catalog["defaults"].value("video", "");
  json out = json::object();
  if (g.contains("generationModelsDataDir") && g["generationModelsDataDir"].is_string()) {
    const std::string custom = g["generationModelsDataDir"].get<std::string>();
    if (!custom.empty() && path_is_under_omega_home(custom)) {
      out["GENERATION_MODELS_DATA_DIR"] = fs::absolute(custom).lexically_normal().string();
    }
  }
  std::string tts_pin =
      g.contains("ttsRepoId") && g["ttsRepoId"].is_string() ? g["ttsRepoId"].get<std::string>() : "";
  std::string image_pin = g.contains("imageRepoId") && g["imageRepoId"].is_string()
                              ? g["imageRepoId"].get<std::string>()
                              : "";
  std::string video_pin = g.contains("videoRepoId") && g["videoRepoId"].is_string()
                              ? g["videoRepoId"].get<std::string>()
                              : "";
  if (tts_pin.empty()) tts_pin = read_config_model_role_pin("contentStudioTtsRepoId");
  if (image_pin.empty()) image_pin = read_config_model_role_pin("contentStudioImageRepoId");
  if (video_pin.empty()) video_pin = read_config_model_role_pin("contentStudioVideoRepoId");
  out["DEFAULT_HF_TTS_REPO_ID"] = !tts_pin.empty() ? tts_pin : default_tts;
  out["DEFAULT_HF_IMAGE_REPO_ID"] = !image_pin.empty() ? image_pin : default_image;
  out["DEFAULT_HF_VIDEO_REPO_ID"] = !video_pin.empty() ? video_pin : default_video;
  if (g.contains("scriptMode")) out["CONTENT_SCRIPT_MODE"] = g["scriptMode"];
  if (g.contains("omegaModelId") && g["omegaModelId"].is_string() &&
      !g["omegaModelId"].get<std::string>().empty()) {
    out["CONTENT_OMEGA_MODEL_ID"] = g["omegaModelId"];
  }
  out["IMAGE_STEPS_BY_REPO_JSON"] =
      g.contains("imageStepsByRepo") ? g["imageStepsByRepo"].dump() : "{}";
  out["VIDEO_STEPS_BY_REPO_JSON"] =
      g.contains("videoStepsByRepo") ? g["videoStepsByRepo"].dump() : "{}";
  out["IMAGE_SIZE_BY_REPO_JSON"] =
      g.contains("imageSizeByRepo") ? g["imageSizeByRepo"].dump() : "{}";
  out["VIDEO_SIZE_BY_REPO_JSON"] =
      g.contains("videoSizeByRepo") ? g["videoSizeByRepo"].dump() : "{}";
  if (g.contains("imageAdapters") && g["imageAdapters"].is_array() && !g["imageAdapters"].empty()) {
    out["IMAGE_LORA_ADAPTERS_JSON"] = g["imageAdapters"].dump();
  }
  out["OMEGA_CS_IMAGE_VRAM_MODE"] = g.value("imageVramMode", "all_gpu");
  const bool prefer_native = g.value("preferNativeMedia", false);
  out["OMEGA_NATIVE_MEDIA"] = prefer_native ? "1" : "0";
  return out;
}

namespace {

bool dir_nonempty(const fs::path& path) {
  std::error_code ec;
  if (!fs::exists(path, ec) || !fs::is_directory(path, ec)) return false;
  return fs::directory_iterator(path, ec) != fs::directory_iterator();
}

/** True when ``base`` (or a subfolder within ``max_depth``) contains ``model_index.json``. */
bool path_has_model_index(const fs::path& base, int max_depth = 3) {
  if (!fs::is_directory(base)) return false;
  struct Node {
    fs::path path;
    int depth;
  };
  std::vector<Node> queue{{base, 0}};
  while (!queue.empty()) {
    const Node node = queue.front();
    queue.erase(queue.begin());
    std::error_code ec;
    if (fs::exists(node.path / "model_index.json", ec)) return true;
    if (node.depth >= max_depth) continue;
    for (const auto& entry : fs::directory_iterator(node.path, ec)) {
      if (!entry.is_directory(ec)) continue;
      const std::string name = entry.path().filename().string();
      if (name.empty() || name[0] == '.' || name == "blobs" || name == "refs" || name == ".cache")
        continue;
      queue.push_back({entry.path(), node.depth + 1});
    }
  }
  return false;
}

constexpr std::uintmax_t kMinVideoWeightBytes = 50ULL * 1024ULL * 1024ULL;

bool skip_pack_dir_name(const std::string& name) {
  return name.empty() || name[0] == '.' || name == "blobs" || name == "refs" || name == ".cache";
}

bool path_has_incomplete_hf_download(const fs::path& base) {
  const fs::path cache = base / ".cache" / "huggingface" / "download";
  std::error_code ec;
  if (!fs::is_directory(cache, ec)) return false;
  for (const auto& entry : fs::recursive_directory_iterator(cache, ec)) {
    if (!entry.is_regular_file(ec)) continue;
    const std::string fname = entry.path().filename().string();
    if (fname.size() >= 11 && fname.compare(fname.size() - 11, 11, ".incomplete") == 0) {
      return true;
    }
  }
  return false;
}

bool path_has_generation_weights(const fs::path& base, int max_depth = 8) {
  if (!fs::is_directory(base)) return false;
  struct Node {
    fs::path path;
    int depth;
  };
  std::vector<Node> queue{{base, 0}};
  while (!queue.empty()) {
    const Node node = queue.front();
    queue.erase(queue.begin());
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(node.path, ec)) {
      if (entry.is_regular_file(ec)) {
        const std::string fname = entry.path().filename().string();
        const std::string ext = entry.path().extension().string();
        const bool is_weight =
            ext == ".safetensors" || ext == ".ckpt" ||
            fname == "diffusion_pytorch_model.bin" || fname == "pytorch_model.bin";
        if (is_weight) {
          const auto sz = entry.file_size(ec);
          if (!ec && sz >= kMinVideoWeightBytes) return true;
        }
        continue;
      }
      if (!entry.is_directory(ec)) continue;
      const std::string name = entry.path().filename().string();
      if (skip_pack_dir_name(name)) continue;
      if (node.depth < max_depth) queue.push_back({entry.path(), node.depth + 1});
    }
  }
  return false;
}

bool generation_video_pack_ready(const fs::path& pack_dir) {
  if (!path_has_model_index(pack_dir)) return false;
  if (path_has_incomplete_hf_download(pack_dir)) return false;
  return path_has_generation_weights(pack_dir);
}

std::string repo_id_to_folder_name(const std::string& repo_id) {
  std::string out;
  out.reserve(repo_id.size() + 4);
  for (char c : repo_id) {
    if (c == '/') {
      out += "__";
    } else {
      out += c;
    }
  }
  return out;
}

bool generation_model_on_disk_under_root(const fs::path& models_root, const std::string& kind,
                                           const std::string& repo_id) {
  const fs::path kind_root = models_root / kind;
  std::vector<fs::path> candidates;
  candidates.push_back(kind_root / repo_id_to_folder_name(repo_id));
  const size_t slash = repo_id.find('/');
  if (slash != std::string::npos && slash + 1 < repo_id.size()) {
    const std::string org = repo_id.substr(0, slash);
    const std::string leaf = repo_id.substr(slash + 1);
    candidates.push_back(kind_root / org / leaf);
    candidates.push_back(kind_root / (org + "_" + leaf));
    candidates.push_back(kind_root / leaf);
  } else {
    candidates.push_back(kind_root / repo_id);
  }
  for (const auto& path : candidates) {
    if (kind == "video") {
      if (generation_video_pack_ready(path)) return true;
    } else if (dir_nonempty(path)) {
      return true;
    }
  }
  const std::string leaf = slash != std::string::npos ? repo_id.substr(slash + 1) : repo_id;
  std::error_code ec;
  if (!fs::is_directory(kind_root, ec)) return false;
  for (const auto& entry : fs::directory_iterator(kind_root, ec)) {
    if (!entry.is_directory(ec)) continue;
    const std::string name = entry.path().filename().string();
    if (name == leaf || name.find(leaf) != std::string::npos) {
      if (kind == "video") {
        if (generation_video_pack_ready(entry.path())) return true;
      } else if (dir_nonempty(entry.path())) {
        return true;
      }
    }
  }
  return false;
}

bool generation_model_on_disk(const std::string& kind, const std::string& repo_id) {
  return generation_model_on_disk_under_root(
      fs::path(resolve_content_studio_generation_models_root()), kind, repo_id);
}

std::optional<std::string> folder_name_to_repo_id(const std::string& folder) {
  const size_t pos = folder.find("__");
  if (pos == std::string::npos || pos == 0 || pos + 2 >= folder.size()) return std::nullopt;
  return folder.substr(0, pos) + "/" + folder.substr(pos + 2);
}

bool skip_models_dir_name(const std::string& name) {
  return name.empty() || name[0] == '.' || name == "_config_cache";
}

/** Match Python ``localgen.installed_models._iter_snapshot_dirs`` (org__repo + org/repo). */
std::vector<std::pair<std::string, fs::path>> iter_snapshot_dirs(const fs::path& kind_dir) {
  std::vector<std::pair<std::string, fs::path>> found;
  std::error_code ec;
  if (!fs::is_directory(kind_dir, ec)) return found;

  for (const auto& child : fs::directory_iterator(kind_dir, ec)) {
    if (!child.is_directory(ec)) continue;
    const std::string name = child.path().filename().string();
    if (skip_models_dir_name(name)) continue;

    if (name.find("__") != std::string::npos) {
      if (const auto repo_id = folder_name_to_repo_id(name)) {
        found.emplace_back(*repo_id, child.path());
      }
      continue;
    }

    bool added_sub = false;
    for (const auto& sub : fs::directory_iterator(child.path(), ec)) {
      if (!sub.is_directory(ec)) continue;
      const std::string sub_name = sub.path().filename().string();
      if (skip_models_dir_name(sub_name)) continue;
      found.emplace_back(name + "/" + sub_name, sub.path());
      added_sub = true;
    }
    if (!added_sub && dir_nonempty(child.path())) {
      found.emplace_back(name, child.path());
    }
  }
  return found;
}

json scan_installed_kind(const std::string& kind) {
  json out = json::array();
  std::set<std::string> seen;

  auto add_row = [&](const std::string& repo_id, const std::string& label) {
    if (repo_id.empty() || seen.count(repo_id)) return;
    seen.insert(repo_id);
    out.push_back(json{{"key", label.empty() ? repo_id : label},
                       {"repo_id", repo_id},
                       {"description", ""},
                       {"on_disk", true}});
  };

  const fs::path root(resolve_content_studio_generation_models_root());
  const fs::path manifest_path = root / "installed_hf_models.json";
  if (fs::exists(manifest_path)) {
    std::ifstream in(manifest_path);
    const json manifest = json::parse(in, nullptr, false);
    if (!manifest.is_discarded() && manifest.contains("entries") && manifest["entries"].is_array()) {
      for (const auto& entry : manifest["entries"]) {
        if (!entry.is_object()) continue;
        if (entry.value("kind", "") != kind) continue;
        const std::string repo = entry.value("repo_id", "");
        if (repo.empty()) continue;
        if (generation_model_on_disk_under_root(root, kind, repo)) {
          add_row(repo, entry.value("label", repo));
        }
      }
    }
  }

  const fs::path kind_dir = root / kind;
  for (const auto& [repo_id, folder] : iter_snapshot_dirs(kind_dir)) {
    if (kind == "video" && !generation_video_pack_ready(folder)) continue;
    if (kind != "video" && !dir_nonempty(folder)) continue;
    const std::string label = seen.count(repo_id) ? repo_id : repo_id + " (folder)";
    add_row(repo_id, label);
  }
  return out;
}

json model_entry(const char* key, const char* repo_id, const char* description, const char* size,
                 const char* kind, const json& extra = json::object()) {
  json row{{"key", key},
           {"repo_id", repo_id},
           {"description", description},
           {"size", size},
           {"on_disk", generation_model_on_disk(kind, repo_id)}};
  for (auto it = extra.begin(); it != extra.end(); ++it) row[it.key()] = it.value();
  return row;
}

}  // namespace

bool ContentStudioSettings::model_installed(const std::string& kind, const std::string& repo_id) {
  return generation_model_on_disk(kind, repo_id);
}

bool ContentStudioSettings::any_video_model_installed() {
  const json rows = scan_installed_kind("video");
  return rows.is_array() && !rows.empty();
}

namespace {

std::string shell_quote_probe(const std::string& s) {
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

int run_capture_stdout(const std::string& cmd, std::string* out) {
#ifdef _WIN32
  FILE* pipe = _popen(cmd.c_str(), "r");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return -1;
  if (out) out->clear();
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) {
    if (out) *out += buf;
  }
#ifdef _WIN32
  return _pclose(pipe);
#else
  return pclose(pipe);
#endif
}

json probe_media_accelerators() {
  const std::string py = resolve_unified_python();
  if (py.empty() || !fs::exists(py)) return json::object();

  std::ostringstream cmd;
  cmd << content_studio_subprocess_env_prefix();
#ifdef _WIN32
  cmd << shell_quote_probe(py) << " -m localgen.media_accel_probe 2>nul";
#else
  cmd << shell_quote_probe(py) << " -m localgen.media_accel_probe 2>/dev/null";
#endif

  std::string stdout_text;
  if (run_capture_stdout(cmd.str(), &stdout_text) != 0 || stdout_text.empty()) {
    return json::object();
  }
  while (!stdout_text.empty() && (stdout_text.back() == '\n' || stdout_text.back() == '\r')) {
    stdout_text.pop_back();
  }
  try {
    const json parsed = json::parse(stdout_text);
    return parsed.is_object() ? parsed : json::object();
  } catch (...) {
    return json::object();
  }
}

}  // namespace

json ContentStudioSettings::generation_media_summary() {
  const json tts = scan_installed_kind("tts");
  const json image = scan_installed_kind("image");
  const json video = scan_installed_kind("video");
  const std::string py = resolve_unified_python();
  const bool python_ready = !py.empty() && fs::exists(py);
  auto first_repo = [](const json& rows) -> std::string {
    if (!rows.is_array() || rows.empty()) return {};
    const json& row = rows.front();
    return row.is_object() ? row.value("repo_id", "") : "";
  };
  return json{{"pythonReady", python_ready},
              {"studioTtsInstalled", tts.is_array() && !tts.empty()},
              {"studioImageInstalled", image.is_array() && !image.empty()},
              {"studioVideoInstalled", video.is_array() && !video.empty()},
              {"installedTtsCount", tts.is_array() ? static_cast<int>(tts.size()) : 0},
              {"installedImageCount", image.is_array() ? static_cast<int>(image.size()) : 0},
              {"installedVideoCount", video.is_array() ? static_cast<int>(video.size()) : 0},
              {"primaryTtsRepo", first_repo(tts)},
              {"primaryImageRepo", first_repo(image)},
              {"primaryVideoRepo", first_repo(video)},
              {"modelsRoot", resolve_content_studio_generation_models_root()},
              {"accelerators", python_ready ? probe_media_accelerators() : json::object()}};
}

json ContentStudioSettings::local_generation_catalog() const {
  const json suggested_tts = json::array(
      {model_entry("Qwen3-TTS-12Hz-0.6B-CustomVoice", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                   "Smaller Custom Voice model", "~1.5 GB", "tts")});
  const json suggested_image = json::array({model_entry(
      "InterDiffusion-Nano", "cutycat2000/InterDiffusion-Nano",
      "Compact SD 1.5 text-to-image — single-file checkpoint", "~2.0 GB", "image",
      json{{"default_num_steps", 25}, {"default_width", 512}, {"default_height", 512}})});
  const json suggested_video = json::array({model_entry(
      "LTX-Video-0.9.5", "Lightricks/LTX-Video-0.9.5",
      "Lightricks LTX-Video text-to-video (diffusers)", "~8 GB", "video",
      json{{"default_num_frames", 97}, {"default_num_steps", 30}, {"default_fps", 24},
           {"default_width", 704}, {"default_height", 480}})});
  return json{
      {"defaults", json{{"tts", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"},
                        {"image", "cutycat2000/InterDiffusion-Nano"},
                        {"video", ""}}},
      {"suggested_tts_models", suggested_tts},
      {"suggested_image_models", suggested_image},
      {"suggested_video_models", suggested_video},
      {"tts_models", suggested_tts},
      {"image_models", suggested_image},
      {"video_models", suggested_video},
      {"installed_tts", scan_installed_kind("tts")},
      {"installed_image", scan_installed_kind("image")},
      {"installed_video", scan_installed_kind("video")},
      {"models_root", resolve_content_studio_generation_models_root()},
      {"script_modes", json::array({"content_studio", "omega_agent", "agent_orchestrated"})},
      {"active", json{{"tts", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"},
                       {"image", "cutycat2000/InterDiffusion-Nano"},
                       {"video", ""},
                       {"script_mode", "content_studio"},
                       {"omega_model_id", ""}}}};
}

}  // namespace omega::runtime
