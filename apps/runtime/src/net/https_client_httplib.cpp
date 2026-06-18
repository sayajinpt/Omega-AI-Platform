#ifndef _WIN32

#include "omega/runtime/net/https_client.hpp"

#include <httplib.h>

#include <stdexcept>

namespace omega::runtime::https {

namespace {

httplib::Headers to_httplib_headers(const std::map<std::string, std::string>& headers) {
  httplib::Headers h;
  for (const auto& [k, v] : headers) h.emplace(k, v);
  return h;
}

struct UrlParts {
  std::string host;
  int port{443};
  std::string path;
  bool ssl{true};
};

UrlParts parse(const std::string& url) {
  UrlParts p;
  std::string u = url;
  if (u.rfind("https://", 0) == 0) {
    p.ssl = true;
    p.port = 443;
    u = u.substr(8);
  } else if (u.rfind("http://", 0) == 0) {
    p.ssl = false;
    p.port = 80;
    u = u.substr(7);
  } else {
    throw std::runtime_error("URL must be http or https");
  }
  const size_t slash = u.find('/');
  std::string hostport = slash == std::string::npos ? u : u.substr(0, slash);
  p.path = slash == std::string::npos ? "/" : u.substr(slash);
  const size_t colon = hostport.find(':');
  if (colon != std::string::npos) {
    p.host = hostport.substr(0, colon);
    p.port = std::stoi(hostport.substr(colon + 1));
  } else {
    p.host = hostport;
  }
  return p;
}

#ifndef CPPHTTPLIB_OPENSSL_SUPPORT
void require_ssl() {
  throw std::runtime_error(
      "'https' scheme is not supported — rebuild omega-runtime with OpenSSL (CPPHTTPLIB_OPENSSL_SUPPORT)");
}
#endif

}  // namespace

HttpResponse get(const std::string& url, const RequestOptions& opts) {
  const UrlParts parts = parse(url);
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  cli.set_follow_location(opts.follow_redirects);
  if (parts.ssl) cli.enable_server_certificate_verification(true);
  const auto res = cli.Get(parts.path.c_str(), to_httplib_headers(opts.headers));
  if (!res) throw std::runtime_error("HTTPS GET failed");
  return {res->status, res->body};
#else
  if (parts.ssl) require_ssl();
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  const auto res = cli.Get(parts.path.c_str(), to_httplib_headers(opts.headers));
  if (!res) throw std::runtime_error("HTTP GET failed");
  return {res->status, res->body};
#endif
}

HttpResponse post(const std::string& url, const std::string& body, const RequestOptions& opts) {
  const UrlParts parts = parse(url);
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  cli.set_follow_location(opts.follow_redirects);
  if (parts.ssl) cli.enable_server_certificate_verification(true);
  const auto res =
      cli.Post(parts.path.c_str(), to_httplib_headers(opts.headers), body, "application/json");
  if (!res) throw std::runtime_error("HTTPS POST failed");
  return {res->status, res->body};
#else
  if (parts.ssl) require_ssl();
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  const auto res =
      cli.Post(parts.path.c_str(), to_httplib_headers(opts.headers), body, "application/json");
  if (!res) throw std::runtime_error("HTTP POST failed");
  return {res->status, res->body};
#endif
}

HttpResponse get_stream(const std::string& url, const RequestOptions& opts, ChunkCallback on_chunk,
                        ProgressCallback on_progress) {
  const UrlParts parts = parse(url);
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  cli.set_follow_location(opts.follow_redirects);
  if (parts.ssl) cli.enable_server_certificate_verification(true);
  HttpResponse out;
  const auto res = cli.Get(
      parts.path.c_str(), to_httplib_headers(opts.headers),
      [&](const char* data, size_t len) { return on_chunk(data, len); },
      [&](uint64_t current, uint64_t total) {
        if (on_progress) return on_progress(current, total);
        return true;
      });
  if (!res) throw std::runtime_error("HTTPS download failed");
  out.status = res->status;
  return out;
#else
  if (parts.ssl) require_ssl();
  throw std::runtime_error("HTTPS streaming requires OpenSSL-enabled httplib build");
#endif
}

HttpResponse post_stream(const std::string& url, const std::string& body,
                         const RequestOptions& opts, ChunkCallback on_chunk) {
  const UrlParts parts = parse(url);
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(opts.connection_timeout_sec, 0);
  cli.set_read_timeout(opts.read_timeout_sec, 0);
  if (parts.ssl) cli.enable_server_certificate_verification(true);
  HttpResponse out;
  httplib::Request req;
  req.method = "POST";
  req.path = parts.path;
  for (const auto& [k, v] : opts.headers) req.set_header(k, v);
  req.body = body;
  req.content_receiver = [&](const char* data, size_t len, uint64_t, uint64_t) {
    return on_chunk(data, len);
  };
  const auto res = cli.send(req);
  if (!res) throw std::runtime_error("HTTPS POST stream failed");
  out.status = res->status;
  return out;
#else
  if (parts.ssl) require_ssl();
  throw std::runtime_error("HTTPS streaming requires OpenSSL-enabled httplib build");
#endif
}

}  // namespace omega::runtime::https

#endif  // !_WIN32
