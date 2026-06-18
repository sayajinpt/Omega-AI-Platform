#include "omega/shell/static_server.hpp"
#include "omega/shell/app_paths.hpp"

#include <httplib.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <memory>
#include <regex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace omega::shell {

namespace {

std::string profile_home_dir() {
  const std::string home = omega_home();
  const fs::path active_file = fs::path(home) / "active_profile";
  std::string active_id = "default";
  if (fs::exists(active_file)) {
    try {
      std::ifstream in(active_file);
      in >> active_id;
      if (active_id.empty()) active_id = "default";
    } catch (...) {
      active_id = "default";
    }
  }
  if (active_id == "default") return home;
  return (fs::path(home) / "profiles" / active_id).string();
}

bool session_id_safe(const std::string& session_id) {
  if (session_id.empty()) return false;
  static const std::regex ok(R"(^[a-zA-Z0-9_-]+$)");
  return std::regex_match(session_id, ok);
}

bool media_ref_safe(const std::string& ref) {
  if (ref.empty()) return false;
  if (ref.find("..") != std::string::npos) return false;
  if (ref.find('/') != std::string::npos || ref.find('\\') != std::string::npos) return false;
  return true;
}

std::string media_mime(const fs::path& path) {
  std::string ext = path.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (ext == ".mp4") return "video/mp4";
  if (ext == ".webm") return "video/webm";
  if (ext == ".mov") return "video/quicktime";
  if (ext == ".mp3") return "audio/mpeg";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".ogg") return "audio/ogg";
  if (ext == ".m4a") return "audio/mp4";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".gif") return "image/gif";
  if (ext == ".webp") return "image/webp";
  return "application/octet-stream";
}

/** Stream a local file with byte-range support (required for HTML5 video seek/metadata). */
bool serve_local_media_file(const httplib::Request& req, httplib::Response& res,
                            const fs::path& local_path, const std::string& mime) {
  std::error_code ec;
  if (!fs::exists(local_path, ec) || !fs::is_regular_file(local_path, ec)) return false;

  const auto size = static_cast<size_t>(fs::file_size(local_path, ec));
  if (ec || size < 1) return false;

  if (req.method == "HEAD") {
    res.status = 200;
    res.set_header("Content-Type", mime);
    res.set_header("Accept-Ranges", "bytes");
    res.set_header("Cache-Control", "private, max-age=3600");
    res.set_header("Content-Length", std::to_string(size));
    return true;
  }

  auto file = std::make_shared<std::ifstream>(local_path.string(), std::ios::binary);
  if (!file->is_open()) return false;
  res.set_header("Accept-Ranges", "bytes");
  res.set_header("Cache-Control", "private, max-age=3600");
  res.set_content_provider(
      size, mime,
      [file](size_t offset, size_t length, httplib::DataSink& sink) {
        if (!file->seekg(static_cast<std::streamoff>(offset))) return false;
        std::vector<char> buf(length);
        file->read(buf.data(), static_cast<std::streamsize>(length));
        const auto got = static_cast<size_t>(file->gcount());
        if (got == 0) return false;
        return sink.write(buf.data(), got);
      },
      [file](bool) {});
  return true;
}

httplib::Headers proxy_forward_headers(const httplib::Request& req) {
  httplib::Headers out;
  static const char* k_forward[] = {"Range", "If-Range", "If-Modified-Since", "If-None-Match"};
  for (const char* key : k_forward) {
    if (req.has_header(key)) out.emplace(key, req.get_header_value(key));
  }
  return out;
}

void proxy_runtime_get(const std::string& runtime_base, const httplib::Request& req,
                       httplib::Response& res) {
  httplib::Client cli(runtime_base.c_str());
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(600, 0);
  const httplib::Headers forward = proxy_forward_headers(req);
  const auto proxied =
      forward.empty() ? cli.Get(req.target.c_str()) : cli.Get(req.target.c_str(), forward);
  if (!proxied) {
    res.status = 502;
    res.set_content(R"({"error":"runtime unreachable"})", "application/json");
    return;
  }
  res.status = proxied->status;
  for (const auto& h : proxied->headers) {
    if (h.first == "Transfer-Encoding") continue;
    res.set_header(h.first, h.second);
  }
  res.body = proxied->body;
}

void proxy_runtime_head(const std::string& runtime_base, const httplib::Request& req,
                        httplib::Response& res) {
  httplib::Client cli(runtime_base.c_str());
  cli.set_connection_timeout(10, 0);
  cli.set_read_timeout(30, 0);
  const httplib::Headers forward = proxy_forward_headers(req);
  const auto proxied =
      forward.empty() ? cli.Head(req.target.c_str()) : cli.Head(req.target.c_str(), forward);
  if (!proxied) {
    res.status = 502;
    res.set_content(R"({"error":"runtime unreachable"})", "application/json");
    return;
  }
  res.status = proxied->status;
  for (const auto& h : proxied->headers) {
    if (h.first == "Transfer-Encoding") continue;
    res.set_header(h.first, h.second);
  }
}

bool try_serve_session_media_local(const httplib::Request& req, httplib::Response& res) {
  std::string session_id = req.get_param_value("sessionId");
  if (session_id.empty()) session_id = req.get_param_value("session_id");
  std::string ref = req.get_param_value("ref");
  if (!session_id_safe(session_id) || !media_ref_safe(ref)) return false;

  std::string normalized = ref;
  if (normalized.rfind("media/", 0) == 0) normalized = normalized.substr(6);
  if (normalized.rfind("media\\", 0) == 0) normalized = normalized.substr(6);

  const fs::path session_root =
      fs::path(profile_home_dir()) / "projects" / session_id;
  fs::path local = session_root / "media" / normalized;
  std::error_code ec;
  if (!fs::exists(local, ec)) local = session_root / normalized;
  if (!fs::exists(local, ec)) return false;

  return serve_local_media_file(req, res, local, media_mime(local));
}

bool try_serve_cs_job_media_local(const httplib::Request& req, httplib::Response& res) {
  std::string project_id = req.get_param_value("projectId");
  if (project_id.empty()) project_id = req.get_param_value("project_id");
  std::string job_id = req.get_param_value("jobId");
  if (job_id.empty()) job_id = req.get_param_value("job_id");
  if (project_id.empty() || job_id.empty()) return false;
  if (project_id.find("..") != std::string::npos || job_id.find("..") != std::string::npos ||
      project_id.find('/') != std::string::npos || project_id.find('\\') != std::string::npos ||
      job_id.find('/') != std::string::npos || job_id.find('\\') != std::string::npos) {
    return false;
  }

  const fs::path local_mp4 =
      fs::path(content_studio_storage_dir()) / project_id / job_id / "final.mp4";
  return serve_local_media_file(req, res, local_mp4, "video/mp4");
}

}  // namespace

StaticServer::StaticServer() = default;

StaticServer::~StaticServer() { stop(); }

void StaticServer::start(const std::string& root, int port, const std::string& runtime_base) {
  if (running_) return;
  if (!fs::exists(root)) {
    throw std::runtime_error("UI root not found: " + root);
  }

  root_ = fs::absolute(root).string();
  port_ = port;
  runtime_base_ = runtime_base.empty() ? "http://127.0.0.1:9877" : runtime_base;
  running_ = true;
  thread_ = std::thread([this] { run(); });

  for (int i = 0; i < 40; ++i) {
    httplib::Client cli("127.0.0.1", port_);
    cli.set_connection_timeout(1, 0);
    if (cli.Get("/")) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void StaticServer::stop() {
  if (!running_) return;
  running_ = false;
  if (auto* svr = static_cast<httplib::Server*>(server_)) {
    svr->stop();
  }
  if (thread_.joinable()) thread_.join();
  delete static_cast<httplib::Server*>(server_);
  server_ = nullptr;
}

void StaticServer::run() {
  auto svr = std::make_unique<httplib::Server>();
  server_ = svr.get();

  const std::string mount = root_;
  const std::string runtime_base = runtime_base_;

  // cpp-httplib routes HEAD to GET handlers; proxy with Client::Head to avoid downloading bodies.
  auto proxy_runtime_media = [runtime_base](const httplib::Request& req, httplib::Response& res) {
    if (try_serve_session_media_local(req, res)) return;
    if (try_serve_cs_job_media_local(req, res)) return;
    if (req.method == "HEAD") {
      proxy_runtime_head(runtime_base, req, res);
    } else {
      proxy_runtime_get(runtime_base, req, res);
    }
  };

  svr->Get("/v1/sessions/media", proxy_runtime_media);
  svr->Get("/v1/content-studio/jobMedia", proxy_runtime_media);

  svr->set_mount_point("/", mount.c_str());

  svr->set_pre_routing_handler([](const httplib::Request& req, httplib::Response& res) {
    res.set_header("Access-Control-Allow-Origin", "*");
    if (req.method == "OPTIONS") {
      res.status = 204;
      return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });

  svr->listen("127.0.0.1", port_);
}

}  // namespace omega::shell
