#ifdef _WIN32
#include <windows.h>
#else
#include <climits>
#include <unistd.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <cstdint>
#endif

#include "omega/runtime/paths.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <chrono>
#include <iterator>
#include <sstream>

namespace fs = std::filesystem;

namespace omega::runtime {

namespace {

std::string home_from_env() {
#ifdef _WIN32
  wchar_t buf[MAX_PATH]{};
  const DWORD n = GetEnvironmentVariableW(L"USERPROFILE", buf, MAX_PATH);
  if (n > 0 && n < MAX_PATH) {
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, buf, -1, nullptr, 0, nullptr, nullptr);
    if (bytes > 0) {
      std::string out(static_cast<size_t>(bytes), '\0');
      WideCharToMultiByte(CP_UTF8, 0, buf, -1, out.data(), bytes, nullptr, nullptr);
      if (!out.empty() && out.back() == '\0') out.pop_back();
      return out;
    }
  }
  const char* home = std::getenv("USERPROFILE");
#else
  const char* home = std::getenv("HOME");
#endif
  if (!home || !*home) return {};
  return home;
}

#ifdef _WIN32
std::string read_pipe_output(const std::string& cmd) {
  std::string out;
  FILE* pipe = _popen(cmd.c_str(), "r");
  if (!pipe) return out;
  char buf[512];
  while (fgets(buf, sizeof(buf), pipe)) out += buf;
  _pclose(pipe);
  while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) {
    out.pop_back();
  }
  return out;
}
#endif

std::string first_existing(const fs::path* begin, const fs::path* end) {
  for (const fs::path* it = begin; it != end; ++it) {
    std::error_code ec;
    const fs::path abs = fs::absolute(*it, ec);
    if (!ec && fs::exists(abs)) return abs.string();
  }
  return {};
}

std::string trim_ascii(std::string s) {
  while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\r' || s.front() == '\n')) {
    s.erase(s.begin());
  }
  while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n')) {
    s.pop_back();
  }
  if (s.size() >= 2 &&
      ((s.front() == '"' && s.back() == '"') || (s.front() == '\'' && s.back() == '\''))) {
    return s.substr(1, s.size() - 2);
  }
  return s;
}

std::string read_json_string_field(const fs::path& path, const char* key) {
  if (!fs::exists(path)) return {};
  try {
    std::ifstream in(path);
    const nlohmann::json j = nlohmann::json::parse(in);
    if (j.contains(key) && j[key].is_string()) return j[key].get<std::string>();
  } catch (...) {
  }
  return {};
}

bool is_path_under_omega_home(const fs::path& path) {
  std::error_code ec;
  const fs::path home = fs::absolute(fs::path(omega_home()), ec).lexically_normal();
  const fs::path abs = fs::absolute(path, ec).lexically_normal();
  if (ec) return false;
  if (abs == home) return true;
  const fs::path rel = fs::relative(abs, home, ec);
  if (ec || rel.empty()) return false;
  const std::string rel_s = rel.generic_string();
  return rel_s.rfind("..", 0) != 0;
}

}  // namespace

std::string omega_home() {
  const char* env = std::getenv("OMEGA_HOME");
  if (env && *env) return env;
  const auto h = home_from_env();
  if (h.empty()) return ".omega";
  return (fs::path(h) / ".omega").string();
}

std::string config_path() { return (fs::path(omega_home()) / "config.json").string(); }

std::string models_dir() { return (fs::path(omega_home()) / "models").string(); }

std::string plugins_dir() { return (fs::path(omega_home()) / "plugins").string(); }

std::string resolve_ollama_binary() {
  const char* env = std::getenv("OMEGA_OLLAMA_BIN");
  if (env && *env && fs::exists(env)) return env;
#ifdef _WIN32
  const char* exe_name = "omega-ollama.exe";
#else
  const char* exe_name = "omega-ollama";
#endif
  const fs::path candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "bin" / exe_name,
      fs::path(runtime_executable_dir()) / "bin" / exe_name,
      fs::path("dist") / "bin" / exe_name,
      fs::path("..") / ".." / "dist" / "bin" / exe_name,
      fs::path("bin") / exe_name,
      fs::path(exe_name)};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path(runtime_executable_dir()) / ".." / "bin" / exe_name).string();
}

std::string resolve_engine_binary() {
  const char* env = std::getenv("OMEGA_ENGINE_BIN");
  if (env && *env) {
    std::error_code ec;
    if (fs::exists(env, ec)) return env;
  }

  const fs::path candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "engine" / "omega-engine.exe",
      fs::path(runtime_executable_dir()) / "engine" / "omega-engine.exe",
      fs::path("dist") / "engine" / "omega-engine.exe",
      fs::path("..") / ".." / "dist" / "engine" / "omega-engine.exe",
      fs::path("..") / "engine" / "omega-engine.exe",
#ifdef _WIN32
      fs::path("omega-engine.exe")
#else
      fs::path("omega-engine")
#endif
  };

  for (const auto& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (!ec && fs::exists(abs)) return abs.string();
  }
  return (fs::path("dist") / "engine" /
#ifdef _WIN32
          "omega-engine.exe"
#else
          "omega-engine"
#endif
         )
      .string();
}

std::string resolve_bundled_bin_dir() {
  const fs::path engine_dir = fs::path(resolve_engine_binary()).parent_path();
  const fs::path candidates[] = {
      engine_dir.parent_path() / "bin",
      fs::path("bin"),
      fs::path("..") / "bin",
      fs::path("..") / ".." / "dist" / "bin"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (engine_dir.parent_path() / "bin").string();
}

std::string resolve_engine_stderr_log() {
  std::error_code ec;
  const fs::path logs = fs::path(omega_home()) / "logs";
  fs::create_directories(logs, ec);
  return (logs / "omega-engine-stderr.log").string();
}

std::string resolve_load_diagnostic_log() {
  std::error_code ec;
  const fs::path logs = fs::path(omega_home()) / "logs";
  fs::create_directories(logs, ec);
  return (logs / "omega-load.log").string();
}

void append_load_diagnostic(const std::string& message) {
  if (message.empty()) return;
  std::error_code ec;
  const fs::path log_path = fs::path(resolve_load_diagnostic_log());
  fs::create_directories(log_path.parent_path(), ec);
  std::ofstream out(log_path, std::ios::app);
  if (!out) return;
  const auto now = std::chrono::system_clock::now();
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
  out << ms << ' ' << message << '\n';
}

std::string runtime_executable_dir() {
#ifdef _WIN32
  char buf[MAX_PATH]{};
  if (GetModuleFileNameA(nullptr, buf, MAX_PATH)) {
    return fs::path(buf).parent_path().string();
  }
#elif defined(__APPLE__)
  char buf[PATH_MAX]{};
  uint32_t size = sizeof(buf);
  if (_NSGetExecutablePath(buf, &size) == 0) {
    char resolved[PATH_MAX]{};
    if (realpath(buf, resolved)) return fs::path(resolved).parent_path().string();
    return fs::path(buf).parent_path().string();
  }
#elif defined(__linux__)
  char buf[PATH_MAX]{};
  const ssize_t len = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (len > 0) {
    buf[len] = '\0';
    return fs::path(buf).parent_path().string();
  }
#endif
  return fs::current_path().string();
}

std::string resolve_unified_python() {
  const fs::path venv = fs::path(omega_home()) / "venvs" / "unified";
#ifdef _WIN32
  const fs::path py = venv / "Scripts" / "python.exe";
#else
  const fs::path py = venv / "bin" / "python3";
#endif
  return py.string();
}

std::string resolve_resources_root() {
  const char* env = std::getenv("OMEGA_RESOURCES_DIR");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "resources",
      fs::path("resources"),
      fs::path("..") / "resources",
      fs::path(runtime_executable_dir()) / ".." / ".." / "resources"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path(runtime_executable_dir()) / ".." / "resources").string();
}

std::string resolve_engines_root() {
  const char* env = std::getenv("OMEGA_ENGINES_ROOT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path("engines"),
      fs::path("..") / ".." / "engines",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "engines",
      fs::path("resources") / "engines",
      fs::path(resolve_python_unified_root()).parent_path()};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("engines")).string();
}

std::string resolve_python_unified_root() {
  const char* env = std::getenv("OMEGA_PYTHON_UNIFIED_ROOT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path("engines") / "python-unified",
      fs::path("..") / ".." / "engines" / "python-unified",
      fs::path("..") / "engines" / "python-unified",
      fs::path(runtime_executable_dir()) / ".." / ".." / "engines" / "python-unified",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "engines" / "python-unified",
      fs::path("resources") / "engines" / "python-unified"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("engines") / "python-unified").string();
}

std::string resolve_python_runtime_script(const std::string& name) {
  const char* env = std::getenv("OMEGA_PYTHON_RUNTIME_DIR");
  const fs::path file_name = fs::path(name);
  if (env && *env) {
    const fs::path p = fs::path(env) / file_name;
    if (fs::exists(p)) return p.string();
  }
  const fs::path candidates[] = {
      fs::path("python-runtime") / file_name,
      fs::path("resources") / "python-runtime" / file_name,
      fs::path(runtime_executable_dir()) / "python-runtime" / file_name,
      fs::path(runtime_executable_dir()) / "resources" / "python-runtime" / file_name,
      fs::path("apps") / "runtime" / "resources" / "python-runtime" / file_name};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("python-runtime") / file_name).string();
}

std::string resolve_router_models_python() { return resolve_unified_python(); }

std::string resolve_claw3d_office_root() {
  const char* env = std::getenv("OMEGA_CLAW3D_OFFICE_ROOT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path("apps") / "desktop" / "claw3d-office",
      fs::path("..") / "apps" / "desktop" / "claw3d-office",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "claw3d-office",
      fs::path("resources") / "claw3d-office"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("apps") / "desktop" / "claw3d-office").string();
}

std::string resolve_claw3d_standalone_node_modules() {
  const fs::path office = resolve_claw3d_office_root();
  const fs::path flat = fs::path(office) / ".next" / "standalone";
  const fs::path nested = flat / "apps" / "desktop" / "claw3d-office";
  if (fs::exists(nested / "server.js")) {
    const fs::path nm = nested / "node_modules";
    if (fs::exists(nm)) return nm.string();
  }
  const fs::path nm = flat / "node_modules";
  if (fs::exists(nm)) return nm.string();
  return nm.string();
}

std::string resolve_claw3d_adapter_script() {
  const fs::path candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "resources" / "scripts" / "omega-claw3d-adapter.mjs",
      fs::path("resources") / "scripts" / "omega-claw3d-adapter.mjs",
      fs::path("apps") / "desktop" / "scripts" / "omega-claw3d-adapter.mjs",
      fs::path("..") / "apps" / "desktop" / "scripts" / "omega-claw3d-adapter.mjs"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("apps") / "desktop" / "scripts" / "omega-claw3d-adapter.mjs").string();
}

std::string resolve_node_binary() {
  const char* env = std::getenv("OMEGA_NODE_BIN");
  if (env && *env && fs::exists(env)) return env;
#ifdef _WIN32
  const char* home = std::getenv("LOCALAPPDATA");
  const fs::path win_candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "resources" / "node" / "node.exe",
      fs::path(runtime_executable_dir()) / "node.exe",
      fs::path("C:\\Program Files\\nodejs\\node.exe"),
      fs::path(home ? home : "") / "Programs" / "nodejs" / "node.exe"};
  for (const auto& c : win_candidates) {
    if (!c.empty() && fs::exists(c)) return c.string();
  }
  const std::string out = read_pipe_output("where node 2>nul");
  if (!out.empty()) {
    const auto line_end = out.find('\n');
    const std::string first = line_end == std::string::npos ? out : out.substr(0, line_end);
    if (fs::exists(first)) return first;
  }
#endif
  return "node";
}

std::string resolve_content_studio_backend() {
  const char* env = std::getenv("OMEGA_CONTENT_STUDIO_BACKEND");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path(runtime_executable_dir()) / ".." / "resources" / "content-studio" / "backend",
      fs::path("resources") / "content-studio" / "backend",
      fs::path("apps") / "desktop" / "content-studio" / "backend",
      fs::path("..") / "apps" / "desktop" / "content-studio" / "backend"};
  for (const fs::path& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (ec || !fs::is_directory(abs)) continue;
    if (fs::exists(abs / "requirements-omega.txt") || fs::exists(abs / "requirements.txt")) {
      return abs.string();
    }
  }
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("apps") / "desktop" / "content-studio" / "backend").string();
}

std::string resolve_quantize_binary() {
  const char* env = std::getenv("OMEGA_QUANTIZE_BIN");
  if (env && *env && fs::exists(env)) return env;
  const std::string exe_dir = runtime_executable_dir();
  const fs::path candidates[] = {
      fs::path("dist") / "bin" / "llama-quantize.exe",
      fs::path("..") / ".." / "dist" / "bin" / "llama-quantize.exe",
      fs::path(exe_dir) / ".." / "bin" / "llama-quantize.exe",
      fs::path(exe_dir) / "llama-quantize.exe",
      fs::path(omega_home()) / "bin" / "llama-quantize.exe",
#ifdef _WIN32
      fs::path("llama-quantize.exe")
#else
      fs::path("llama-quantize")
#endif
  };
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return {};
}

std::string resolve_sidecar_python() { return resolve_unified_python(); }

std::string resolve_router_models_build_script() {
  const char* env = std::getenv("OMEGA_ROUTER_BUILD_SCRIPT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path("engines") / "router-models" / "build_router_model.py",
      fs::path("..") / ".." / "engines" / "router-models" / "build_router_model.py",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "engines" / "router-models" /
          "build_router_model.py"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("engines") / "router-models" / "build_router_model.py").string();
}

std::string resolve_content_studio_download_script() {
  const char* env = std::getenv("OMEGA_CS_DOWNLOAD_SCRIPT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path("apps") / "desktop" / "content-studio" / "scripts" / "download_hf_model.py",
      fs::path("..") / "apps" / "desktop" / "content-studio" / "scripts" / "download_hf_model.py",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "content-studio" / "scripts" /
          "download_hf_model.py"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path("apps") / "desktop" / "content-studio" / "scripts" / "download_hf_model.py")
      .string();
}

std::string resolve_content_studio_generation_models() {
  const char* env = std::getenv("OMEGA_CS_GENERATION_MODELS");
  if (env && *env && fs::exists(env)) return fs::absolute(env).string();
  const fs::path candidates[] = {
      fs::path(resolve_content_studio_backend()).parent_path() / "generation_models",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "content-studio" / "generation_models",
      fs::path("resources") / "content-studio" / "generation_models",
      fs::path("apps") / "desktop" / "content-studio" / "generation_models",
      fs::path("..") / "apps" / "desktop" / "content-studio" / "generation_models"};
  for (const fs::path& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (ec || !fs::exists(abs / "localgen")) continue;
    return abs.string();
  }
  return {};
}

std::string resolve_content_studio_storage() {
  const char* env = std::getenv("OMEGA_CS_STORAGE_PATH");
  if (env && *env) {
    const fs::path p(env);
    if (fs::exists(p) || !p.parent_path().empty()) return fs::absolute(p).lexically_normal().string();
  }
  return fs::absolute(fs::path(omega_home()) / "content-studio" / "storage").lexically_normal().string();
}

std::string resolve_content_studio_generation_models_root() {
  if (const char* env = std::getenv("GENERATION_MODELS_DATA_DIR"); env && *env) {
    const fs::path p = fs::absolute(env).lexically_normal();
    if (is_path_under_omega_home(p)) return p.string();
  }
  const std::string custom = read_json_string_field(
      fs::path(omega_home()) / "content-studio-generation.json", "generationModelsDataDir");
  if (!custom.empty()) {
    const fs::path p = fs::absolute(custom).lexically_normal();
    if (is_path_under_omega_home(p)) return p.string();
  }
  return fs::absolute(fs::path(models_dir()) / "generation-models").lexically_normal().string();
}

bool path_is_under_omega_home(const std::string& path) {
  return is_path_under_omega_home(fs::path(path));
}

std::string resolve_content_studio_data_dir() {
  const char* env = std::getenv("OMEGA_CS_DATA_DIR");
  if (env && *env) return fs::absolute(env).lexically_normal().string();
  return fs::absolute(fs::path(omega_home()) / "content-studio" / "data").lexically_normal().string();
}

std::string resolve_content_studio_database_url() {
  const fs::path db = fs::path(resolve_content_studio_data_dir()) / "media_auto.db";
  std::string p = fs::absolute(db).lexically_normal().string();
#ifdef _WIN32
  for (char& c : p) {
    if (c == '\\') c = '/';
  }
#endif
  return "sqlite:///" + p;
}

std::string resolve_content_studio_native_media_script() {
  const char* env = std::getenv("OMEGA_NATIVE_MEDIA_SCRIPT");
  if (env && *env && fs::exists(env)) return env;
  const fs::path candidates[] = {
      fs::path(resolve_content_studio_backend()) / "app" / "cli" / "native_media_phase.py",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "content-studio" / "backend" /
          "app" / "cli" / "native_media_phase.py"};
  const std::string found = first_existing(std::begin(candidates), std::end(candidates));
  if (!found.empty()) return found;
  return (fs::path(resolve_content_studio_backend()) / "app" / "cli" / "native_media_phase.py")
      .string();
}

std::string content_studio_subprocess_env_prefix() {
  std::ostringstream prefix;
#ifdef _WIN32
  auto set_var = [&](const char* key, const std::string& value) {
    if (value.empty()) return;
    prefix << "set \"" << key << '=';
    for (char c : value) {
      if (c == '"') prefix << "\\\"";
      else prefix << c;
    }
    prefix << "\" && ";
  };
#else
  auto set_var = [&](const char* key, const std::string& value) {
    if (value.empty()) return;
    std::string escaped = value;
    for (char& c : escaped) {
      if (c == '\'') c = '"';
    }
    prefix << key << "='" << escaped << "' ";
  };
#endif
  auto set_if_unset = [&](const char* key, const std::string& value) {
    if (value.empty()) return;
    if (const char* existing = std::getenv(key); existing && *existing) return;
    set_var(key, value);
  };

  const std::string backend = resolve_content_studio_backend();
  const std::string gen_models = resolve_content_studio_generation_models();
#ifdef _WIN32
  const std::string py_path = gen_models + ";" + backend;
#else
  const std::string py_path = gen_models + ":" + backend;
#endif
  set_var("PYTHONPATH", py_path);
  set_var("OMEGA_CS_STORAGE_PATH", resolve_content_studio_storage());
  set_var("OMEGA_CS_DATA_DIR", resolve_content_studio_data_dir());
  set_var("DATABASE_URL", resolve_content_studio_database_url());
  set_var("GENERATION_MODELS_DATA_DIR", resolve_content_studio_generation_models_root());
  set_var("OMEGA_CS_JOB_SUBPROCESS", "1");
  set_var("OMEGA_CS_INVOKE", "1");
  set_var("PYTHONUNBUFFERED", "1");

  if (const char* rt = std::getenv("OMEGA_RUNTIME_PORT"); rt && *rt) {
    set_var("OMEGA_RUNTIME_PORT", rt);
  } else {
    const fs::path rt_state = fs::path(omega_home()) / "runtime-state.json";
    if (fs::exists(rt_state)) {
      try {
        std::ifstream in(rt_state);
        const nlohmann::json st = nlohmann::json::parse(in);
        if (st.contains("port")) {
          set_var("OMEGA_RUNTIME_PORT", std::to_string(st["port"].get<int>()));
        }
      } catch (...) {
      }
    }
  }

  const fs::path gen_path = fs::path(omega_home()) / "content-studio-generation.json";
  if (fs::exists(gen_path)) {
    try {
      std::ifstream in(gen_path);
      const nlohmann::json g = nlohmann::json::parse(in);
      if (g.contains("generationModelsDataDir") && g["generationModelsDataDir"].is_string()) {
        const std::string custom = g["generationModelsDataDir"].get<std::string>();
        if (!custom.empty() && path_is_under_omega_home(custom)) {
          set_if_unset("GENERATION_MODELS_DATA_DIR",
                       fs::absolute(custom).lexically_normal().string());
        }
      }
      if (g.contains("ttsRepoId") && g["ttsRepoId"].is_string() &&
          !g["ttsRepoId"].get<std::string>().empty()) {
        set_if_unset("DEFAULT_HF_TTS_REPO_ID", g["ttsRepoId"].get<std::string>());
      }
      if (g.contains("imageRepoId") && g["imageRepoId"].is_string() &&
          !g["imageRepoId"].get<std::string>().empty()) {
        set_if_unset("DEFAULT_HF_IMAGE_REPO_ID", g["imageRepoId"].get<std::string>());
      }
      if (g.contains("videoRepoId") && g["videoRepoId"].is_string() &&
          !g["videoRepoId"].get<std::string>().empty()) {
        set_if_unset("DEFAULT_HF_VIDEO_REPO_ID", g["videoRepoId"].get<std::string>());
      }
      if (g.contains("scriptMode") && g["scriptMode"].is_string()) {
        set_if_unset("CONTENT_SCRIPT_MODE", g["scriptMode"].get<std::string>());
      }
      if (g.contains("omegaModelId") && g["omegaModelId"].is_string() &&
          !g["omegaModelId"].get<std::string>().empty()) {
        set_if_unset("CONTENT_OMEGA_MODEL_ID", g["omegaModelId"].get<std::string>());
      }
      if (g.contains("imageStepsByRepo")) {
        set_if_unset("IMAGE_STEPS_BY_REPO_JSON", g["imageStepsByRepo"].dump());
      }
      if (g.contains("videoStepsByRepo")) {
        set_if_unset("VIDEO_STEPS_BY_REPO_JSON", g["videoStepsByRepo"].dump());
      }
      if (g.contains("imageSizeByRepo")) {
        set_if_unset("IMAGE_SIZE_BY_REPO_JSON", g["imageSizeByRepo"].dump());
      }
      if (g.contains("videoSizeByRepo")) {
        set_if_unset("VIDEO_SIZE_BY_REPO_JSON", g["videoSizeByRepo"].dump());
      }
      if (g.contains("imageAdapters") && g["imageAdapters"].is_array() && !g["imageAdapters"].empty()) {
        set_if_unset("IMAGE_LORA_ADAPTERS_JSON", g["imageAdapters"].dump());
      }
      if (g.contains("imageVramMode") && g["imageVramMode"].is_string()) {
        set_if_unset("OMEGA_CS_IMAGE_VRAM_MODE", g["imageVramMode"].get<std::string>());
      } else {
        set_if_unset("OMEGA_CS_IMAGE_VRAM_MODE", "all_gpu");
      }
      const bool prefer_native = g.value("preferNativeMedia", false);
      set_if_unset("OMEGA_NATIVE_MEDIA", prefer_native ? "1" : "0");
    } catch (...) {
    }
  }

  static const char* k_forward_env[] = {
      "DEFAULT_HF_TTS_REPO_ID",     "DEFAULT_HF_IMAGE_REPO_ID", "DEFAULT_HF_VIDEO_REPO_ID",
      "CONTENT_SCRIPT_MODE",        "CONTENT_OMEGA_MODEL_ID",   "IMAGE_STEPS_BY_REPO_JSON",
      "VIDEO_STEPS_BY_REPO_JSON",   "IMAGE_SIZE_BY_REPO_JSON",  "VIDEO_SIZE_BY_REPO_JSON",
      "IMAGE_LORA_ADAPTERS_JSON",
      "IMAGE_NUM_STEPS",            "VIDEO_NUM_STEPS",          "OMEGA_CS_IMAGE_VRAM_MODE",
      "OMEGA_NATIVE_MEDIA",         "HF_TOKEN",                 "HUGGING_FACE_HUB_TOKEN",
      "TAVILY_API_KEY",             "OPENAI_API_KEY",           "CURSOR_API_KEY",
  };
  for (const char* key : k_forward_env) {
    if (const char* val = std::getenv(key); val && *val) {
      set_var(key, val);
    }
  }

  return prefix.str();
}

}  // namespace omega::runtime
