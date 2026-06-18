#include "omega/runtime/services/updater_service.hpp"

#include "omega/runtime/paths.hpp"

#include <httplib.h>

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <shellapi.h>
#include <windows.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::vector<int> parse_version_parts(const std::string& v) {
  std::vector<int> parts;
  std::stringstream ss(v);
  std::string token;
  while (std::getline(ss, token, '.')) {
    try {
      parts.push_back(std::stoi(token));
    } catch (...) {
      parts.push_back(0);
    }
  }
  return parts;
}

}  // namespace

UpdaterService::UpdaterService(EventBus& events) : events_(events) {
  status_ = json{{"checking", false},
                 {"available", false},
                 {"packaged", is_packaged()},
                 {"currentVersion", current_version()},
                 {"manifestSource", manifest_source()}};
}

json UpdaterService::status() const {
  std::lock_guard lock(mu_);
  return status_;
}

void UpdaterService::publish_status() const {
  events_.publish("omega:updater:status-event", status_);
  events_.publish("omega:updater:status", status_);
}

std::string UpdaterService::current_version() const {
  const char* env = std::getenv("OMEGA_VERSION");
  if (env && *env) return env;
  const fs::path version_file = fs::path(runtime_executable_dir()) / "VERSION";
  if (fs::exists(version_file)) {
    std::ifstream in(version_file);
    std::string line;
    if (std::getline(in, line)) {
      while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
      if (!line.empty()) return line;
    }
  }
  return "0.1.0";
}

std::string UpdaterService::manifest_source() const {
  const char* env = std::getenv("OMEGA_UPDATE_MANIFEST");
  if (env && *env) return env;
  const fs::path local = fs::path(omega_home()) / "update-manifest.json";
  if (fs::exists(local)) return local.string();
  return "";
}

bool UpdaterService::is_packaged() const {
  const char* env = std::getenv("OMEGA_PACKAGED");
  if (env && *env && env[0] != '0') return true;
  const fs::path exe_dir = runtime_executable_dir();
  return fs::exists(exe_dir / "omega-desktop.exe") || fs::exists(exe_dir / ".." / "omega-desktop.exe");
}

int UpdaterService::compare_versions(const std::string& a, const std::string& b) const {
  const auto pa = parse_version_parts(a);
  const auto pb = parse_version_parts(b);
  const size_t n = std::max(pa.size(), pb.size());
  for (size_t i = 0; i < n; ++i) {
    const int va = i < pa.size() ? pa[i] : 0;
    const int vb = i < pb.size() ? pb[i] : 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

std::optional<json> UpdaterService::load_manifest() const {
  const std::string source = manifest_source();
  if (source.empty()) return std::nullopt;

  if (source.rfind("http://", 0) == 0 || source.rfind("https://", 0) == 0) {
    const bool https = source.rfind("https://", 0) == 0;
    const size_t scheme_len = https ? 8 : 7;
    const size_t path_start = source.find('/', scheme_len);
    const std::string origin =
        path_start == std::string::npos ? source : source.substr(0, path_start);
    const std::string path = path_start == std::string::npos ? "/" : source.substr(path_start);
    httplib::Client cli(origin.c_str());
    cli.set_connection_timeout(10, 0);
    cli.set_read_timeout(30, 0);
    cli.set_follow_location(true);
    const auto res = cli.Get(path.c_str());
    if (!res || res->status >= 400 || res->body.empty()) return std::nullopt;
    try {
      return json::parse(res->body);
    } catch (...) {
      return std::nullopt;
    }
  }

  if (!fs::exists(source)) return std::nullopt;
  try {
    std::ifstream in(source);
    return json::parse(in);
  } catch (...) {
    return std::nullopt;
  }
}

json UpdaterService::check() {
  std::lock_guard lock(mu_);
  status_ = json{{"checking", true},
                 {"available", false},
                 {"packaged", is_packaged()},
                 {"currentVersion", current_version()},
                 {"manifestSource", manifest_source()}};
  publish_status();

  const std::string current = current_version();
  const auto manifest = load_manifest();
  if (!manifest) {
    status_ = json{{"checking", false},
                   {"available", false},
                   {"packaged", is_packaged()},
                   {"currentVersion", current},
                   {"manifestSource", manifest_source()},
                   {"message", "No update manifest configured. Set OMEGA_UPDATE_MANIFEST or place "
                                 "~/.omega/update-manifest.json"}};
    publish_status();
    return status_;
  }

  const std::string latest = manifest->value("version", "");
  const std::string url = manifest->value("url", manifest->value("installerUrl", ""));
  const std::string notes = manifest->value("notes", manifest->value("releaseNotes", ""));

  if (latest.empty() || url.empty()) {
    status_ = json{{"checking", false},
                   {"available", false},
                   {"currentVersion", current},
                   {"error", "Manifest missing version or url"}};
    publish_status();
    return status_;
  }

  const bool available = compare_versions(current, latest) < 0;
  installer_path_.clear();

  status_ = json{{"checking", false},
                 {"available", available},
                 {"packaged", is_packaged()},
                 {"currentVersion", current},
                 {"version", latest},
                 {"notes", notes},
                 {"manifestSource", manifest_source()},
                 {"downloadReady", false}};

  if (available) {
    status_["message"] = "Update " + latest + " is available.";
    if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) {
      status_["installerUrl"] = url;
    } else if (fs::exists(url)) {
      installer_path_ = fs::absolute(url).string();
      status_["downloadReady"] = true;
      status_["message"] = "Update installer ready at " + installer_path_;
    }
  } else {
    status_["message"] = "You are on the latest version (" + current + ").";
  }

  publish_status();
  return status_;
}

json UpdaterService::install() {
  std::lock_guard lock(mu_);
  if (!status_.value("available", false)) {
    status_["message"] = "No update available — run check first.";
    publish_status();
    return status_;
  }

  std::string installer = installer_path_;
  if (installer.empty()) {
    const std::string url = status_.value("installerUrl", "");
    if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) {
#ifdef _WIN32
      const int wlen = MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, nullptr, 0);
      std::wstring wurl(static_cast<size_t>(wlen), L'\0');
      MultiByteToWideChar(CP_UTF8, 0, url.c_str(), -1, wurl.data(), wlen);
      if (!wurl.empty() && wurl.back() == L'\0') wurl.pop_back();
      HINSTANCE rc = ShellExecuteW(nullptr, L"open", wurl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
      if (reinterpret_cast<intptr_t>(rc) > 32) {
        status_["message"] = "Opened update download in your browser.";
        publish_status();
        return status_;
      }
#else
      if (std::system((std::string("open '") + url + "'").c_str()) == 0 ||
          std::system((std::string("xdg-open '") + url + "'").c_str()) == 0) {
        status_["message"] = "Opened update download in your browser.";
        publish_status();
        return status_;
      }
#endif
      status_["error"] = "Could not open installer URL — download manually: " + url;
      publish_status();
      return status_;
    }
  }

  if (installer.empty() || !fs::exists(installer)) {
    status_["error"] = "Installer file not found — run check again.";
    publish_status();
    return status_;
  }

#ifdef _WIN32
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, installer.c_str(), -1, nullptr, 0);
  std::wstring wpath(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, installer.c_str(), -1, wpath.data(), wlen);
  if (!wpath.empty() && wpath.back() == L'\0') wpath.pop_back();
  HINSTANCE rc = ShellExecuteW(nullptr, L"open", wpath.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  if (reinterpret_cast<intptr_t>(rc) > 32) {
    status_["message"] = "Launching Omega installer…";
    publish_status();
    return status_;
  }
  status_["error"] = "Failed to launch installer: " + installer;
#else
  std::string cmd;
#if defined(__APPLE__)
  cmd = "open '" + installer + "'";
#else
  cmd = "xdg-open '" + installer + "'";
#endif
  if (std::system(cmd.c_str()) == 0) {
    status_["message"] = "Launching Omega installer…";
    publish_status();
    return status_;
  }
  status_["error"] = "Failed to launch installer: " + installer;
#endif
  publish_status();
  return status_;
}

}  // namespace omega::runtime
