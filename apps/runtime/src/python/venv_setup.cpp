#include "omega/runtime/python/venv_setup.hpp"

#include "omega/runtime/paths.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace omega::runtime {

namespace {

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
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
  std::string out = "'";
  for (char c : s) {
    if (c == '\'') out += "'\\''";
    else out += c;
  }
  out += "'";
  return out;
#endif
}

int run_capture_lines(const std::string& cmd,
                      const std::function<void(const std::string& line)>& on_line) {
#ifdef _WIN32
  FILE* pipe = _popen(cmd.c_str(), "r");
#else
  FILE* pipe = popen(cmd.c_str(), "r");
#endif
  if (!pipe) return -1;
  char buf[4096];
  while (fgets(buf, sizeof(buf), pipe)) {
    std::string line = buf;
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    if (!line.empty() && on_line) on_line(line);
  }
#ifdef _WIN32
  return _pclose(pipe);
#else
  return pclose(pipe);
#endif
}

int run_command(const std::string& cmd,
                const std::function<void(const std::string& line)>& on_line = nullptr) {
  if (on_line) return run_capture_lines(cmd, on_line);
  return std::system(cmd.c_str());
}

bool python_version_ok(const std::string& launcher) {
  bool ok = false;
  static const std::regex re(R"(Python 3\.(\d+))");
  run_capture_lines(launcher + " --version 2>&1", [&](const std::string& line) {
    std::smatch m;
    if (std::regex_search(line, m, re)) {
      try {
        if (std::stoi(m[1].str()) >= 10) ok = true;
      } catch (...) {
      }
    }
  });
  return ok;
}

std::string resolve_repo_root() {
  const fs::path engines = resolve_engines_root();
  const fs::path sidecar_req = engines / "sidecar" / "requirements.txt";
  if (fs::exists(sidecar_req)) {
    const fs::path parent = engines.parent_path();
    if (parent.filename() == "resources") return parent.string();
    return engines.parent_path().string();
  }
  const std::string unified = resolve_python_unified_root();
  std::error_code ec;
  const fs::path abs = fs::absolute(unified, ec);
  if (ec) return unified;
  return abs.parent_path().parent_path().string();
}

std::string unified_venv_python_path() { return resolve_unified_python(); }

std::string unified_venv_dir() { return (fs::path(omega_home()) / "venvs" / "unified").string(); }

void append_log_tail(std::deque<std::string>& tail, const std::string& line, size_t max_lines = 24) {
  tail.push_back(line);
  while (tail.size() > max_lines) tail.pop_front();
}

std::string tail_to_string(const std::deque<std::string>& tail) {
  std::string out;
  for (const auto& line : tail) {
    if (!out.empty()) out += "\n";
    out += line;
  }
  return out;
}

void write_setup_log(const std::string& text) {
  try {
    const fs::path log_dir = fs::path(omega_home()) / "content-studio" / "logs";
    fs::create_directories(log_dir);
    std::ofstream out(log_dir / "setup.log", std::ios::app);
    out << text << "\n";
  } catch (...) {
  }
}

fs::path canonical_path(const fs::path& p) {
  std::error_code ec;
  const fs::path canon = fs::weakly_canonical(p, ec);
  if (!ec && !canon.empty()) return canon;
  return fs::absolute(p);
}

int pip_install(const std::string& py, const fs::path& req_path_in, const std::string& label,
                const VenvProgressCallback& on_progress, bool no_cache = false) {
  const fs::path req_abs = canonical_path(req_path_in);
  if (!fs::exists(req_abs)) {
    on_progress("error", "requirements missing: " + req_abs.string());
    return 1;
  }
  on_progress("packages", label);
  on_progress("pip", "requirements: " + req_abs.string());
  // Absolute -r path: pip resolves relative lines in the file against this file's directory.
  std::string cmd =
      shell_quote(py) + " -m pip install -r " + shell_quote(req_abs.string());
  if (no_cache) cmd += " --no-cache-dir";
  cmd += " 2>&1";
  std::deque<std::string> tail;
  const int code = run_capture_lines(cmd, [&](const std::string& line) {
    append_log_tail(tail, line);
    on_progress("pip", line);
  });
  if (code != 0) {
    const std::string msg = label + " failed (pip exit " + std::to_string(code) + ")";
    const std::string detail = tail_to_string(tail);
    on_progress("error", detail.empty() ? msg : (msg + "\n" + detail));
    write_setup_log(msg + "\n" + detail);
  }
  return code;
}

int pip_install_editable(const std::string& py, const fs::path& package_dir,
                         const fs::path& cwd, const std::string& label,
                         const VenvProgressCallback& on_progress, bool optional = false,
                         const std::string& extras = "") {
  const fs::path pkg_abs = fs::absolute(package_dir);
  if (!fs::exists(pkg_abs / "pyproject.toml") && !fs::exists(pkg_abs / "setup.py")) {
    const std::string msg = label + " skipped — package not found at " + pkg_abs.string();
    if (optional) {
      on_progress("pip", msg);
      return 0;
    }
    on_progress("error", msg);
    return 1;
  }
  on_progress("packages", label);
  const fs::path cwd_abs = fs::absolute(cwd);
  std::string editable_spec = pkg_abs.string();
  if (!extras.empty()) editable_spec += extras;
#ifdef _WIN32
  const std::string full = "cmd /c cd /d " + shell_quote(cwd_abs.string()) + " && " + shell_quote(py) +
                           " -m pip install -e " + shell_quote(editable_spec) + " 2>&1";
#else
  const std::string full = "cd " + shell_quote(cwd_abs.string()) + " && " + shell_quote(py) +
                           " -m pip install -e " + shell_quote(editable_spec) + " 2>&1";
#endif
  std::deque<std::string> tail;
  const int code = run_capture_lines(full, [&](const std::string& line) {
    append_log_tail(tail, line);
    on_progress("pip", line);
  });
  if (code != 0) {
    const std::string msg = label + " failed (pip exit " + std::to_string(code) + ")";
    const std::string detail = tail_to_string(tail);
    if (optional) {
      on_progress("pip", "optional " + label + " skipped: " + (detail.empty() ? msg : detail));
      return 0;
    }
    on_progress("error", detail.empty() ? msg : (msg + "\n" + detail));
    write_setup_log(msg + "\n" + detail);
  }
  return optional ? 0 : code;
}

int pip_install_specs(const std::string& py, const std::string& pip_args, const std::string& label,
                      const VenvProgressCallback& on_progress) {
  on_progress("packages", label);
  const std::string cmd = shell_quote(py) + " -m pip install " + pip_args + " 2>&1";
  std::deque<std::string> tail;
  const int code = run_capture_lines(cmd, [&](const std::string& line) {
    append_log_tail(tail, line);
    on_progress("pip", line);
  });
  if (code != 0) {
    const std::string msg = label + " failed (pip exit " + std::to_string(code) + ")";
    const std::string detail = tail_to_string(tail);
    on_progress("error", detail.empty() ? msg : (msg + "\n" + detail));
    write_setup_log(msg + "\n" + detail);
  }
  return code;
}

int install_selected_sidecar_components(const std::string& py, bool exl2, bool onnx,
                                        const VenvProgressCallback& on_progress) {
  if (!exl2 && !onnx) return 0;
  int code = pip_install_specs(py, "fastapi>=0.115.0 \"uvicorn[standard]>=0.32.0\"",
                               "sidecar API server", on_progress);
  if (code != 0) return code;
  if (exl2) {
    on_progress("torch", "Installing PyTorch (CUDA) for ExLlamaV2 — several minutes");
    code = pip_install_specs(
        py,
        "torch --index-url https://download.pytorch.org/whl/cu124 --extra-index-url "
        "https://pypi.org/simple",
        "PyTorch (CUDA)", on_progress);
    if (code != 0) return code;
    code = pip_install_specs(py, "exllamav2>=0.3.2", "exllamav2", on_progress);
    if (code != 0) return code;
  }
  if (onnx) {
    code = pip_install_specs(py, "onnxruntime-genai>=0.8.0", "onnxruntime-genai", on_progress);
    if (code != 0) return code;
  }
  return 0;
}

bool write_venv_profile(const fs::path& venv_dir, const std::string& profile, bool want_sidecar,
                        bool want_router, bool setup_complete = false) {
  try {
    std::ofstream prof(venv_dir / ".omega-profile");
    prof << nlohmann::json{{"profile", profile},
                          {"sidecar_exl2", want_sidecar},
                          {"sidecar_onnx", want_sidecar},
                          {"router_models", want_router},
                          {"setupComplete", setup_complete}}
                .dump(2);
    return true;
  } catch (...) {
    return false;
  }
}

}  // namespace

std::string find_system_python_launcher() {
#ifdef _WIN32
  const char* candidates[] = {"py -3.13", "py -3.12", "py -3.11", "py -3.10", "python"};
#else
  const char* candidates[] = {"python3.13", "python3.12", "python3.11", "python3.10", "python3",
                              "python"};
#endif
  for (const char* c : candidates) {
    if (python_version_ok(c)) return c;
  }

#ifdef _WIN32
  /** GUI-launched Omega often has a trimmed PATH — probe standard install locations. */
  std::vector<fs::path> roots;
  if (const char* local = std::getenv("LOCALAPPDATA"); local && *local) {
    roots.push_back(fs::path(local) / "Programs" / "Python");
  }
  roots.push_back(fs::path("C:\\Program Files") / "Python311");
  roots.push_back(fs::path("C:\\Program Files") / "Python312");
  roots.push_back(fs::path("C:\\Program Files") / "Python313");
  if (const char* pf86 = std::getenv("ProgramFiles(x86)"); pf86 && *pf86) {
    roots.push_back(fs::path(pf86) / "Python311");
    roots.push_back(fs::path(pf86) / "Python312");
  }
  for (const fs::path& root : roots) {
    std::error_code ec;
    if (!fs::exists(root, ec)) continue;
    if (fs::is_directory(root, ec) && fs::exists(root / "python.exe", ec)) {
      const std::string cmd = (root / "python.exe").string();
      if (python_version_ok(cmd)) return cmd;
      continue;
    }
    for (const auto& ent : fs::directory_iterator(root, ec)) {
      if (ec || !ent.is_directory()) continue;
      const fs::path py = ent.path() / "python.exe";
      if (!fs::exists(py, ec)) continue;
      const std::string cmd = py.string();
      if (python_version_ok(cmd)) return cmd;
    }
  }
#endif
  return {};
}

int install_content_studio_local_media(const std::string& py, const VenvProgressCallback& on_progress) {
  const VenvProgressCallback noop = [](const std::string&, const std::string&) {};
  const VenvProgressCallback& progress = on_progress ? on_progress : noop;

  const fs::path cs_backend = canonical_path(fs::path(resolve_content_studio_backend()));
  const fs::path content_media = cs_backend / "requirements-local-media.txt";
  if (!fs::exists(content_media)) {
    progress("error",
              "Content Studio local media requirements missing: " + content_media.string());
    return 1;
  }
  int code = pip_install(py, content_media, "content studio local media (torch stack)", progress,
                         true);
  if (code != 0) return code;

  const std::string gen_models = resolve_content_studio_generation_models();
  if (gen_models.empty()) {
    progress("error",
              "generation_models not found — expected next to Content Studio backend "
              "(resources/content-studio/generation_models)");
    return 1;
  }
  const fs::path gen_path(gen_models);
  code = pip_install_editable(py, gen_path, gen_path.parent_path(),
                              "generation_models [tts,image,video]", progress, false,
                              "[tts,image,video]");
  if (code != 0) return code;
  progress("content-media", "done");
  return 0;
}

int install_content_studio_stack(const std::string& py, const VenvProgressCallback& on_progress) {
  const VenvProgressCallback noop = [](const std::string&, const std::string&) {};
  const VenvProgressCallback& progress = on_progress ? on_progress : noop;

  const fs::path cs_backend = canonical_path(fs::path(resolve_content_studio_backend()));
  fs::path content_req = cs_backend / "requirements-omega.txt";
  if (!fs::exists(content_req)) content_req = cs_backend / "requirements.txt";
  const fs::path gen_models = cs_backend.parent_path() / "generation_models";

  if (!fs::exists(content_req)) {
    progress("error",
              "Content Studio requirements missing under " + cs_backend.string() +
                  " (expected requirements-omega.txt or requirements.txt)");
    return 1;
  }
  int code = pip_install(py, content_req, "content studio API", progress);
  if (code != 0) return code;
  if (fs::exists(gen_models)) {
    code = pip_install_editable(py, gen_models, gen_models.parent_path(),
                                "generation_models [tts,image,video]", progress, false,
                                "[tts,image,video]");
    if (code != 0) return code;
  }
  return 0;
}

int run_unified_venv_setup(const UnifiedVenvSetupOptions& opts,
                           const VenvProgressCallback& on_progress) {
  const std::string profile = lower_copy(opts.profile.empty() ? "base" : opts.profile);
  const std::string launcher = find_system_python_launcher();
  if (launcher.empty()) {
    on_progress(
        "error",
        "Python 3.10+ not found.\n"
        "Install from https://python.org — enable \"Install launcher for all users (py.exe)\" and "
        "\"Add python.exe to PATH\", then restart Omega.\n"
        "If Python is already installed, disable Windows Store app execution aliases for "
        "python.exe (Settings → Apps → Advanced app settings).\n"
        "Log: " +
            (fs::path(omega_home()) / "content-studio" / "logs" / "setup.log").string());
    return 1;
  }

  const std::string unified_root = resolve_python_unified_root();
  const std::string engines_root = resolve_engines_root();
  const fs::path venv_dir = unified_venv_dir();
  fs::create_directories(venv_dir.parent_path());

  on_progress("start", "profile=" + profile);

  const std::string py_path = unified_venv_python_path();
  const bool venv_preexisting = fs::exists(py_path);
  if (!venv_preexisting) {
    on_progress("venv", "creating with " + launcher);
    const std::string create_cmd = launcher + " -m venv " + shell_quote(venv_dir.string()) + " 2>&1";
    std::deque<std::string> create_tail;
    const int create_code = run_capture_lines(create_cmd, [&](const std::string& line) {
      append_log_tail(create_tail, line);
      on_progress("venv", line);
    });
    if (create_code != 0) {
      const std::string detail = tail_to_string(create_tail);
      std::string msg = "venv create failed using " + launcher;
      if (!detail.empty()) msg += ":\n" + detail;
      else msg += " (exit " + std::to_string(create_code) + ")";
      msg += "\nCheck write access to " + venv_dir.string() +
             " and that Python includes the venv module (reinstall from python.org if needed).";
      on_progress("error", msg);
      write_setup_log(msg);
      return create_code;
    }
  }

  const std::string py = unified_venv_python_path();
  if (!fs::exists(py)) {
    on_progress("error", "unified venv python missing after create");
    return 1;
  }

  const bool want_sidecar = opts.sidecar_exl2 || opts.sidecar_onnx || profile == "sidecar" ||
                            profile == "full";
  const bool want_router = opts.router_models || profile == "full";

  /** Existing venv: Content Studio API + GPU media (repair / upgrade only). */
  if (profile == "content" && venv_preexisting) {
    on_progress("start", "profile=content-only");
    on_progress("pip", "installing Content Studio packages into unified venv");
    int code = install_content_studio_stack(py, on_progress);
    if (code != 0) return code;
    code = install_content_studio_local_media(py, on_progress);
    if (code != 0) return code;
    write_venv_profile(venv_dir, profile, want_sidecar, want_router, true);
    on_progress("done", py);
    return 0;
  }

  /** Existing venv: GPU media only (repair when API stack already present). */
  if (profile == "content-media" && venv_preexisting) {
    on_progress("start", "profile=content-media");
    on_progress("pip", "installing Content Studio GPU media packages into unified venv");
    const int code = install_content_studio_local_media(py, on_progress);
    if (code != 0) return code;
    write_venv_profile(venv_dir, "content", want_sidecar, want_router, true);
    on_progress("done", py);
    return 0;
  }

  /** Existing venv: optional EXL2/ONNX only (Settings → sidecar install). */
  if (profile == "sidecar" && venv_preexisting) {
    on_progress("start", "profile=sidecar-only");
    const int code =
        install_selected_sidecar_components(py, opts.sidecar_exl2, opts.sidecar_onnx, on_progress);
    if (code != 0) return code;
    write_venv_profile(venv_dir, profile, opts.sidecar_exl2 || opts.sidecar_onnx, want_router, true);
    on_progress("done", py);
    return 0;
  }

  on_progress("pip", "upgrade pip");
  run_command(shell_quote(py) + " -m pip install --upgrade pip wheel setuptools 2>&1");

  const fs::path unified_req = fs::path(unified_root) / "requirements-unified.txt";
  if (!fs::exists(unified_req)) {
    on_progress("error", "requirements missing: " + unified_req.string());
    return 1;
  }

  int code = pip_install(py, unified_req, "base requirements", on_progress);
  if (code != 0) return code;

  on_progress("playwright", "installing chromium");
  code = run_command(shell_quote(py) + " -m playwright install chromium 2>&1",
                     [&](const std::string& line) { on_progress("playwright", line); });
  if (code != 0) {
    on_progress("playwright", "chromium install failed (stealth fetch may be unavailable)");
  }

  if (want_sidecar) {
    if (profile == "sidecar" && (opts.sidecar_exl2 || opts.sidecar_onnx)) {
      code = install_selected_sidecar_components(py, opts.sidecar_exl2, opts.sidecar_onnx, on_progress);
    } else {
      const fs::path sidecar_req = fs::path(engines_root) / "sidecar" / "requirements.txt";
      code = pip_install(py, sidecar_req, "sidecar stack", on_progress);
    }
    if (code != 0) return code;
  }

  if (want_router) {
    const fs::path router_req = fs::path(engines_root) / "router-models" / "requirements.txt";
    code = pip_install(py, router_req, "router models stack", on_progress);
    if (code != 0) return code;
  }

  const bool content_media_profile = profile == "content" || profile == "full";
  if (content_media_profile) {
    code = install_content_studio_stack(py, on_progress);
    if (code != 0) return code;
    code = install_content_studio_local_media(py, on_progress);
    if (code != 0) return code;
    write_venv_profile(venv_dir, profile, want_sidecar, want_router, true);
  } else if (profile == "content-media") {
    code = install_content_studio_local_media(py, on_progress);
    if (code != 0) return code;
    write_venv_profile(venv_dir, profile, want_sidecar, want_router, true);
  } else {
    write_venv_profile(venv_dir, profile, want_sidecar, want_router, false);
  }

  on_progress("done", py);
  return 0;
}

}  // namespace omega::runtime
