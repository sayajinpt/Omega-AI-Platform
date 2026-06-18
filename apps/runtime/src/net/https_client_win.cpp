#ifdef _WIN32

#include "omega/runtime/net/https_client.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <winhttp.h>

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <sstream>
#include <vector>

#pragma comment(lib, "winhttp.lib")

namespace omega::runtime::https {

namespace {

struct ParsedUrl {
  std::wstring host;
  std::wstring path;
  INTERNET_PORT port{443};
  bool secure{true};
};

std::wstring widen(const std::string& s) {
  if (s.empty()) return L"";
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
  if (!out.empty() && out.back() == L'\0') out.pop_back();
  return out;
}

std::string narrow(const std::wstring& ws) {
  if (ws.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), -1, out.data(), n, nullptr, nullptr);
  if (!out.empty() && out.back() == '\0') out.pop_back();
  return out;
}

ParsedUrl parse_url(const std::string& url) {
  std::string u = url;
  ParsedUrl p;
  const bool https = u.rfind("https://", 0) == 0;
  const bool http = !https && u.rfind("http://", 0) == 0;
  if (!https && !http) throw std::runtime_error("URL must be http or https");
  p.secure = https;
  const size_t scheme_end = u.find("://");
  u = u.substr(scheme_end + 3);
  std::string hostport;
  std::string path = "/";
  const size_t slash = u.find('/');
  if (slash == std::string::npos) {
    hostport = u;
  } else {
    hostport = u.substr(0, slash);
    path = u.substr(slash);
    if (path.empty()) path = "/";
  }
  const size_t colon = hostport.find(':');
  if (colon != std::string::npos) {
    p.host = widen(hostport.substr(0, colon));
    p.port = static_cast<INTERNET_PORT>(std::stoi(hostport.substr(colon + 1)));
  } else {
    p.host = widen(hostport);
    p.port = p.secure ? 443 : 80;
  }
  p.path = widen(path);
  return p;
}

std::wstring header_block(const std::map<std::string, std::string>& headers) {
  std::wstring block;
  for (const auto& [k, v] : headers) {
    block += widen(k + ": " + v);
    block += L"\r\n";
  }
  return block;
}

DWORD resolve_timeout_ms(int sec) {
  if (sec <= 0) return 30'000;
  return static_cast<DWORD>(std::min(sec, 3'600)) * 1000;
}

bool query_status(HINTERNET request, DWORD& status) {
  status = 0;
  DWORD size = sizeof(status);
  return WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
                             WINHTTP_NO_HEADER_INDEX) != FALSE;
}

std::wstring query_header(HINTERNET request, DWORD info_level) {
  DWORD size = 0;
  WinHttpQueryHeaders(request, info_level, WINHTTP_HEADER_NAME_BY_INDEX, WINHTTP_NO_OUTPUT_BUFFER,
                      &size, WINHTTP_NO_HEADER_INDEX);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return L"";
  std::vector<wchar_t> buf(size / sizeof(wchar_t) + 1, L'\0');
  if (!WinHttpQueryHeaders(request, info_level, WINHTTP_HEADER_NAME_BY_INDEX, buf.data(), &size,
                           WINHTTP_NO_HEADER_INDEX)) {
    return L"";
  }
  return std::wstring(buf.data());
}

uint64_t query_content_length(HINTERNET request) {
  const std::wstring cl = query_header(request, WINHTTP_QUERY_CONTENT_LENGTH);
  if (cl.empty()) return 0;
  try {
    return std::stoull(narrow(cl));
  } catch (...) {
    return 0;
  }
}

std::string absolute_redirect_url(const std::string& base_url, const std::wstring& location) {
  const std::string loc = narrow(location);
  if (loc.empty()) return {};
  if (loc.rfind("http://", 0) == 0 || loc.rfind("https://", 0) == 0) return loc;
  if (loc.front() == '/') {
    const size_t scheme = base_url.find("://");
    if (scheme == std::string::npos) return loc;
    const size_t host_start = scheme + 3;
    const size_t path_start = base_url.find('/', host_start);
    const std::string origin =
        path_start == std::string::npos ? base_url : base_url.substr(0, path_start);
    return origin + loc;
  }
  const size_t last = base_url.rfind('/');
  const std::string prefix = last == std::string::npos ? base_url : base_url.substr(0, last + 1);
  return prefix + loc;
}

HttpResponse execute_request(const std::string& method, const std::string& url,
                             const RequestOptions& opts, const std::string& body,
                             const ChunkCallback& on_chunk, const ProgressCallback& on_progress,
                             bool collect_body) {
  std::string current_url = url;
  HttpResponse out;
  const std::wstring wmethod = widen(method);

  for (int redirect = 0; redirect < 12; ++redirect) {
    const ParsedUrl parsed = parse_url(current_url);
    const DWORD flags = parsed.secure ? WINHTTP_FLAG_SECURE : 0;

    HINTERNET session =
        WinHttpOpen(L"omega-runtime/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
                    WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) throw std::runtime_error("WinHttpOpen failed");

    WinHttpSetTimeouts(session, resolve_timeout_ms(opts.connection_timeout_sec),
                       resolve_timeout_ms(opts.connection_timeout_sec),
                       resolve_timeout_ms(opts.read_timeout_sec),
                       resolve_timeout_ms(opts.read_timeout_sec));

    HINTERNET connect = WinHttpConnect(session, parsed.host.c_str(), parsed.port, 0);
    if (!connect) {
      WinHttpCloseHandle(session);
      throw std::runtime_error("WinHttpConnect failed");
    }

    HINTERNET request =
        WinHttpOpenRequest(connect, wmethod.c_str(), parsed.path.c_str(), nullptr,
                           WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) {
      WinHttpCloseHandle(connect);
      WinHttpCloseHandle(session);
      throw std::runtime_error("WinHttpOpenRequest failed");
    }

    const std::wstring hdrs = header_block(opts.headers);
    const wchar_t* hdr_ptr = hdrs.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : hdrs.c_str();
    const DWORD hdr_len = hdrs.empty() ? 0 : static_cast<DWORD>(-1);

    const void* body_ptr = body.empty() ? WINHTTP_NO_REQUEST_DATA : body.data();
    const DWORD body_len = static_cast<DWORD>(body.size());

    if (!WinHttpSendRequest(request, hdr_ptr, hdr_len, const_cast<void*>(body_ptr), body_len,
                            body_len, 0) ||
        !WinHttpReceiveResponse(request, nullptr)) {
      WinHttpCloseHandle(request);
      WinHttpCloseHandle(connect);
      WinHttpCloseHandle(session);
      throw std::runtime_error("HTTPS " + method + " request failed");
    }

    DWORD status = 0;
    query_status(request, status);
    out.status = static_cast<int>(status);

    if (opts.follow_redirects &&
        (status == 301 || status == 302 || status == 303 || status == 307 || status == 308)) {
      const std::wstring location = query_header(request, WINHTTP_QUERY_LOCATION);
      WinHttpCloseHandle(request);
      WinHttpCloseHandle(connect);
      WinHttpCloseHandle(session);
      const std::string next = absolute_redirect_url(current_url, location);
      if (next.empty()) break;
      current_url = next;
      continue;
    }

    if (status < 200 || status >= 300) {
      std::vector<char> err_buf(16 * 1024);
      for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(request, &avail) || avail == 0) break;
        if (avail > err_buf.size()) err_buf.resize(avail);
        DWORD read = 0;
        if (!WinHttpReadData(request, err_buf.data(), avail, &read) || read == 0) break;
        out.body.append(err_buf.data(), read);
      }
      WinHttpCloseHandle(request);
      WinHttpCloseHandle(connect);
      WinHttpCloseHandle(session);
      return out;
    }

    const uint64_t total = query_content_length(request);
    uint64_t received = 0;
    if (on_progress) on_progress(0, total);

    std::vector<char> buf(64 * 1024);
    for (;;) {
      DWORD avail = 0;
      if (!WinHttpQueryDataAvailable(request, &avail)) break;
      if (avail == 0) break;
      if (avail > buf.size()) buf.resize(avail);
      DWORD read = 0;
      if (!WinHttpReadData(request, buf.data(), avail, &read) || read == 0) break;
      received += read;
      if (on_chunk && !on_chunk(buf.data(), static_cast<size_t>(read))) {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        throw std::runtime_error("download cancelled");
      }
      if (collect_body) out.body.append(buf.data(), read);
      if (on_progress && !on_progress(received, total)) {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        throw std::runtime_error("download cancelled");
      }
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return out;
  }

  return out;
}

}  // namespace

HttpResponse get(const std::string& url, const RequestOptions& opts) {
  return execute_request("GET", url, opts, "", nullptr, nullptr, true);
}

HttpResponse post(const std::string& url, const std::string& body, const RequestOptions& opts) {
  return execute_request("POST", url, opts, body, nullptr, nullptr, true);
}

HttpResponse get_stream(const std::string& url, const RequestOptions& opts, ChunkCallback on_chunk,
                        ProgressCallback on_progress) {
  return execute_request("GET", url, opts, "", std::move(on_chunk), std::move(on_progress), false);
}

HttpResponse post_stream(const std::string& url, const std::string& body,
                         const RequestOptions& opts, ChunkCallback on_chunk) {
  return execute_request("POST", url, opts, body, std::move(on_chunk), nullptr, false);
}

}  // namespace omega::runtime::https

#endif  // _WIN32
