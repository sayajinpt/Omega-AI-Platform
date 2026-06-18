#include "omega/shell/shell_http_server.hpp"

#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/overlay_window.hpp"
#include "omega/shell/platform_window.hpp"
#include "omega/shell/screen_snip_service.hpp"
#include "omega/shell/shell_context.hpp"
#include "omega/shell/shell_ui_dispatch.hpp"

#include <httplib.h>
#include <nlohmann/json.hpp>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace omega::shell {

using json = nlohmann::json;

namespace {

json parse_body(const httplib::Request& req) {
  if (req.body.empty()) return json::object();
  return json::parse(req.body);
}

void json_response(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_header("Access-Control-Allow-Origin", "*");
  res.set_header("Content-Type", "application/json");
  res.set_content(body.dump(), "application/json");
}

/** Accept {bounds:{...}}, raw {x,y,width,height}, or IPC array [{x,...}]. */
bool parse_browser_bounds_json(const json& body, BrowserBounds& out) {
  json bounds_obj;
  if (body.is_array() && !body.empty() && body[0].is_object()) {
    bounds_obj = body[0];
  } else if (body.contains("bounds") && body["bounds"].is_object()) {
    bounds_obj = body["bounds"];
  } else if (body.is_object() && body.contains("x") && body.contains("width")) {
    bounds_obj = body;
  }
  if (bounds_obj.is_null()) return false;
  // Unwrap accidental double nesting: {bounds:{bounds:{x,...}}}.
  for (int depth = 0; depth < 8; ++depth) {
    if (bounds_obj.contains("x") && bounds_obj.contains("width")) break;
    if (bounds_obj.contains("bounds") && bounds_obj["bounds"].is_object()) {
      bounds_obj = bounds_obj["bounds"];
      continue;
    }
    return false;
  }
  if (!bounds_obj.contains("x") || !bounds_obj.contains("width") || !bounds_obj.contains("height")) {
    return false;
  }
  out.x = bounds_obj.value("x", 0);
  out.y = bounds_obj.value("y", 0);
  out.width = bounds_obj.value("width", 0);
  out.height = bounds_obj.value("height", 0);
  return out.width >= 8 && out.height >= 8;
}

json proxy_post(const std::string& base, const std::string& path, const json& body) {
  httplib::Client cli(base.c_str());
  cli.set_connection_timeout(5, 0);
  cli.set_read_timeout(120, 0);
  const auto res = cli.Post(path.c_str(), body.dump(), "application/json");
  if (!res || res->status >= 400) {
    throw std::runtime_error("runtime proxy failed for " + path);
  }
  return json::parse(res->body);
}

}  // namespace

struct ShellHttpServer::Impl {
  ShellContext* ctx{nullptr};
  std::unique_ptr<httplib::Server> server;
  std::thread thread;
  bool running{false};
  std::mutex avatar_mu;
  bool avatar_enabled{false};
  bool avatar_overlay_visible{false};
  int avatar_x{100};
  int avatar_y{100};
  int avatar_w{297};
  int avatar_h{297};
};

ShellHttpServer::ShellHttpServer() : impl_(new Impl) {}
ShellHttpServer::~ShellHttpServer() { stop(); delete impl_; impl_ = nullptr; }

void ShellHttpServer::start(ShellContext& ctx) {
  if (impl_->running) return;
  impl_->ctx = &ctx;
  if (ctx.avatar_overlay) {
    ctx.avatar_overlay->set_close_handler([this]() {
      ShellContext* shell_ctx = impl_->ctx;
      shell_ui_run_async(shell_ctx->main_window, [this, shell_ctx]() {
        if (shell_ctx->avatar_overlay) shell_ctx->avatar_overlay->teardown();
        {
          std::lock_guard lock(impl_->avatar_mu);
          impl_->avatar_enabled = false;
          impl_->avatar_overlay_visible = false;
        }
        if (shell_ctx->main_webview) {
          shell_ctx->main_webview->post_shell_event("omega:avatar-monitor:enabled",
                                                    R"({"enabled":false})");
        }
      });
    });
  }
  impl_->server = std::make_unique<httplib::Server>();
  auto* svr = impl_->server.get();

  svr->Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
    res.status = 204;
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type");
  });

  svr->Get("/healthz", [](const httplib::Request&, httplib::Response& res) {
    json_response(res, 200, json{{"ok", true}, {"shell", true}, {"port", kShellHttpPort}});
  });

  svr->Post("/v1/content-studio/webhook", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      proxy_post(impl_->ctx->runtime_base, "/v1/content-studio/webhook", body);
      json_response(res, 200, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/browser/show", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      BrowserBounds b{};
      if (!parse_browser_bounds_json(body, b) || b.width < 8 || b.height < 8) {
        json_response(res, 400, json{{"error", "invalid browser bounds"}});
        return;
      }
      ShellContext* ctx = impl_->ctx;
      const NativeWindow main_win = ctx->main_window;
      std::string current_url;
      shell_ui_run_sync(main_win, [ctx, b, &current_url]() {
        ctx->browser->show(b);
        current_url = ctx->browser->current_url();
      });
      json_response(res, 200, json{{"ok", true}, {"url", current_url}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/browser/hide", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    shell_ui_run_sync(ctx->main_window, [ctx]() { ctx->browser->hide(); });
    json_response(res, 200, json{{"ok", true}});
  });

  svr->Post("/v1/shell/browser/mediaCommand", [this](const httplib::Request& req, httplib::Response& res) {
    const json body = parse_body(req);
    const std::string action = body.value("action", "");
    if (action.empty()) {
      json_response(res, 400, json{{"error", "action required (pause|resume|stop)"}});
      return;
    }
    ShellContext* ctx = impl_->ctx;
    bool ok = false;
    shell_ui_run_sync(ctx->main_window, [ctx, action, &ok]() {
      ok = ctx->browser->media_command(action);
    });
    json_response(res, 200, json{{"ok", ok}, {"action", action}});
  });

  svr->Post("/v1/shell/browser/setBounds", [this](const httplib::Request& req, httplib::Response& res) {
    const json body = parse_body(req);
    BrowserBounds b{};
    if (!parse_browser_bounds_json(body, b) || b.width < 8 || b.height < 8) {
      json_response(res, 400, json{{"error", "invalid browser bounds"}});
      return;
    }
    ShellContext* ctx = impl_->ctx;
    shell_ui_run_sync(ctx->main_window, [ctx, b]() { ctx->browser->set_bounds(b); });
    json_response(res, 200, json{{"ok", true}});
  });

  svr->Post("/v1/shell/browser/navigate", [this](const httplib::Request& req, httplib::Response& res) {
    const json body = parse_body(req);
    const std::string url = body.value("url", "");
    ShellContext* ctx = impl_->ctx;
    bool navigated = false;
    bool loading = false;
    std::string current_url;
    std::string title;
    bool can_back = false;
    bool can_fwd = false;
    shell_ui_run_sync(ctx->main_window, [ctx, url, &navigated, &loading, &current_url, &title, &can_back,
                                         &can_fwd]() {
      navigated = ctx->browser->navigate(url);
      loading = ctx->browser->loading();
      current_url = ctx->browser->current_url();
      if (current_url.empty()) current_url = url;
      title = ctx->browser->document_title();
      can_back = ctx->browser->can_go_back();
      can_fwd = ctx->browser->can_go_forward();
    });
    json_response(res, 200, json{{"url", current_url},
                                  {"title", title},
                                  {"canGoBack", can_back},
                                  {"canGoForward", can_fwd},
                                  {"loading", loading},
                                  {"opened", navigated}});
  });

  svr->Post("/v1/shell/browser/back", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    bool ok = false;
    shell_ui_run_sync(ctx->main_window, [ctx, &ok]() { ok = ctx->browser->back(); });
    json_response(res, 200, json{{"ok", ok}});
  });

  svr->Post("/v1/shell/browser/forward", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    bool ok = false;
    shell_ui_run_sync(ctx->main_window, [ctx, &ok]() { ok = ctx->browser->forward(); });
    json_response(res, 200, json{{"ok", ok}});
  });

  svr->Post("/v1/shell/browser/reload", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    bool ok = false;
    shell_ui_run_sync(ctx->main_window, [ctx, &ok]() { ok = ctx->browser->reload(); });
    json_response(res, 200, json{{"ok", ok}});
  });

  svr->Get("/v1/shell/browser/status", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    std::string url;
    std::string title;
    bool visible = false;
    bool loading = false;
    bool can_back = false;
    bool can_fwd = false;
    bool ready = false;
    shell_ui_run_sync(ctx->main_window, [ctx, &url, &title, &visible, &loading, &can_back, &can_fwd, &ready]() {
      url = ctx->browser->current_url();
      title = ctx->browser->document_title();
      visible = ctx->browser->visible();
      loading = ctx->browser->loading();
      can_back = ctx->browser->can_go_back();
      can_fwd = ctx->browser->can_go_forward();
      ready = ctx->browser->webview_ready();
    });
    json_response(res, 200, json{{"url", url},
                                  {"title", title},
                                  {"visible", visible},
                                  {"loading", loading},
                                  {"canGoBack", can_back},
                                  {"canGoForward", can_fwd},
                                  {"webviewReady", ready}});
  });

  svr->Get("/v1/shell/browser/info", [](const httplib::Request&, httplib::Response& res) {
#if defined(_WIN32)
    json_response(res, 200, json{{"engine", "WebView2"}, {"stealth", true}});
#elif defined(__APPLE__)
    json_response(res, 200, json{{"engine", "WKWebView"}, {"stealth", true}});
#else
    json_response(res, 200, json{{"engine", "WebKitGTK"}, {"stealth", true}});
#endif
  });

  svr->Post("/v1/shell/media/showPreview", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      if (impl_->ctx->main_webview) {
        impl_->ctx->main_webview->post_shell_event("omega:media:showPreview", body.dump());
      }
      json_response(res, 200, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/media/reopenSessionVideo", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      if (impl_->ctx->main_webview) {
        impl_->ctx->main_webview->post_shell_event("omega:media:reopenSessionVideo", body.dump());
      }
      json_response(res, 200, json{{"ok", true}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/screen-snip/capture", [this](const httplib::Request&, httplib::Response& res) {
    try {
      json_response(res, 200, impl_->ctx->screen_snip->capture());
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Get("/v1/shell/screen-snip/bounds", [this](const httplib::Request&, httplib::Response& res) {
    json_response(res, 200, impl_->ctx->screen_snip->get_bounds());
  });

  svr->Post("/v1/shell/screen-snip/submit", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json_response(res, 200, impl_->ctx->screen_snip->submit(parse_body(req)));
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/screen-snip/cancel", [this](const httplib::Request&, httplib::Response& res) {
    json_response(res, 200, impl_->ctx->screen_snip->cancel());
  });

  svr->Post("/v1/shell/screen-snip/save", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json_response(res, 200, impl_->ctx->screen_snip->save(parse_body(req)));
    } catch (const std::exception& e) {
      json_response(res, 501, json{{"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/avatar-monitor/set-enabled", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      bool enabled = body.value("enabled", false);
      json state = json::object();
      if (body.is_array() && !body.empty()) {
        enabled = body[0].get<bool>();
        if (body.size() > 1 && body[1].is_object()) state = body[1];
      } else if (body.contains("state") && body["state"].is_object()) {
        state = body["state"];
      }
      int x = 100, y = 100, w = 320, h = 420;
      if (!state.is_null()) {
        x = state.value("x", x);
        y = state.value("y", y);
        w = state.value("width", w);
        h = state.value("height", h);
        const double scale = state.value("scale", 1.35);
        if (!state.contains("width") && scale > 0) {
          const int side = static_cast<int>(220.0 * scale + 0.5);
          w = side;
          h = side;
        }
      }
      const std::string page_url = impl_->ctx->ui_page_url("avatar-monitor.html");
      ShellContext* ctx = impl_->ctx;
      const NativeWindow main_win = ctx->main_window;
      {
        std::lock_guard lock(impl_->avatar_mu);
        impl_->avatar_x = x;
        impl_->avatar_y = y;
        impl_->avatar_w = w;
        impl_->avatar_h = h;
      }
      bool overlay_visible = false;
      shell_ui_run_sync(main_win, [ctx, enabled, page_url, x, y, w, h, &overlay_visible]() {
        if (!ctx->avatar_overlay) return;
        if (enabled) {
          ctx->avatar_overlay->show(page_url, x, y, w, h);
          overlay_visible = true;
          if (ctx->main_webview) {
            ctx->main_webview->post_shell_event("omega:avatar-monitor:enabled",
                                                R"({"enabled":true})");
          }
        } else {
          ctx->avatar_overlay->teardown();
          overlay_visible = false;
          if (ctx->main_webview) {
            ctx->main_webview->post_shell_event("omega:avatar-monitor:enabled",
                                                R"({"enabled":false})");
          }
        }
      });
      {
        std::lock_guard lock(impl_->avatar_mu);
        impl_->avatar_enabled = enabled;
        impl_->avatar_overlay_visible = overlay_visible;
      }
      json_response(res, 200, json{{"enabled", enabled}, {"overlayVisible", overlay_visible}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"enabled", false}, {"error", e.what()}});
    }
  });

  svr->Post("/v1/shell/avatar-monitor/set-overlay-visible",
            [this](const httplib::Request& req, httplib::Response& res) {
              try {
                const json body = parse_body(req);
                const bool visible = body.value("visible", true);
                ShellContext* ctx = impl_->ctx;
                bool detached = false;
                {
                  std::lock_guard lock(impl_->avatar_mu);
                  detached = impl_->avatar_enabled;
                }
                if (!detached) {
                  json_response(res, 200, json{{"ok", false}, {"overlayVisible", false}});
                  return;
                }
                int x = 100, y = 100, w = 297, h = 297;
                {
                  std::lock_guard lock(impl_->avatar_mu);
                  x = impl_->avatar_x;
                  y = impl_->avatar_y;
                  w = impl_->avatar_w;
                  h = impl_->avatar_h;
                }
                const std::string page_url = ctx->ui_page_url("avatar-monitor.html");
                shell_ui_run_sync(ctx->main_window, [ctx, visible, page_url, x, y, w, h]() {
                  if (!ctx->avatar_overlay) return;
                  if (visible) {
                    ctx->avatar_overlay->show(page_url, x, y, w, h);
                  } else {
                    ctx->avatar_overlay->hide();
                  }
                });
                {
                  std::lock_guard lock(impl_->avatar_mu);
                  impl_->avatar_overlay_visible = visible;
                }
                json_response(res, 200, json{{"ok", true}, {"overlayVisible", visible}});
              } catch (const std::exception& e) {
                json_response(res, 500, json{{"ok", false}, {"error", e.what()}});
              }
            });

  svr->Post("/v1/shell/avatar-monitor/sync-layout", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      bool detached = false;
      int x = 100, y = 100, w = 297, h = 297;
      {
        std::lock_guard lock(impl_->avatar_mu);
        detached = impl_->avatar_enabled;
        if (body.contains("x")) x = body.value("x", impl_->avatar_x);
        else x = impl_->avatar_x;
        if (body.contains("y")) y = body.value("y", impl_->avatar_y);
        else y = impl_->avatar_y;
        const double scale = body.value("scale", 0.0);
        if (body.contains("width") && body.contains("height")) {
          w = body.value("width", impl_->avatar_w);
          h = body.value("height", impl_->avatar_h);
        } else if (scale > 0) {
          const int side = static_cast<int>(220.0 * scale + 0.5);
          w = side;
          h = side;
        } else {
          w = impl_->avatar_w;
          h = impl_->avatar_h;
        }
        impl_->avatar_x = x;
        impl_->avatar_y = y;
        impl_->avatar_w = w;
        impl_->avatar_h = h;
      }
      if (detached && impl_->ctx && impl_->ctx->avatar_overlay) {
        ShellContext* ctx = impl_->ctx;
        shell_ui_run_sync(ctx->main_window, [ctx, x, y, w, h]() {
          if (!ctx->avatar_overlay || !ctx->avatar_overlay->visible()) return;
#ifdef _WIN32
          HWND hwnd = ctx->avatar_overlay->hwnd();
          if (hwnd) SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW);
#endif
        });
      }
      json_response(res, 200, json{{"applied", detached}, {"x", x}, {"y", y}, {"width", w}, {"height", h}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"applied", false}, {"error", e.what()}});
    }
  });

  svr->Get("/v1/shell/avatar-monitor/status", [this](const httplib::Request&, httplib::Response& res) {
    std::lock_guard lock(impl_->avatar_mu);
    json_response(res, 200, json{{"enabled", impl_->avatar_enabled},
                                 {"overlayVisible", impl_->avatar_overlay_visible}});
  });

  svr->Post("/v1/shell/avatar-monitor/restore-main", [this](const httplib::Request&, httplib::Response& res) {
    ShellContext* ctx = impl_->ctx;
    shell_ui_run_sync(ctx->main_window, [ctx]() {
      if (ctx->main_webview) ctx->main_webview->focus_host_window();
    });
    json_response(res, 200, json{{"focused", true}});
  });

  svr->Post("/v1/shell/companion/send-to-main", [this](const httplib::Request& req, httplib::Response& res) {
    const json body = parse_body(req);
    const std::string text = body.value("text", "");
    if (text.empty() && (!body.contains("attachments") || !body["attachments"].is_array() ||
                         body["attachments"].empty())) {
      json_response(res, 200, json{{"ok", false}, {"error", "Empty message"}});
      return;
    }
    if (!impl_->ctx->main_webview) {
      json_response(res, 503, json{{"ok", false}, {"error", "Main window not ready"}});
      return;
    }
    const std::string payload_json = body.dump();
    ShellContext* ctx = impl_->ctx;
    shell_ui_run_sync(ctx->main_window, [ctx, payload_json]() {
      if (!ctx->main_webview) return;
      ctx->main_webview->focus_host_window();
      ctx->main_webview->post_shell_event("omega:companion:send-deliver", payload_json);
    });
    json_response(res, 200, json{{"ok", true}});
  });

  svr->Post("/v1/shell/open-url", [](const httplib::Request& req, httplib::Response& res) {
    try {
      const json body = parse_body(req);
      const std::string url = body.value("url", "");
      if (url.empty()) throw std::runtime_error("url required");
      if (!open_url_in_browser(url)) throw std::runtime_error("failed to open URL");
      json_response(res, 200, json{{"ok", true}, {"url", url}});
    } catch (const std::exception& e) {
      json_response(res, 500, json{{"error", e.what()}});
    }
  });

  impl_->running = true;
  impl_->thread = std::thread([this] {
    impl_->server->listen("127.0.0.1", kShellHttpPort);
    impl_->running = false;
  });
}

void ShellHttpServer::stop() {
  if (!impl_->running && !impl_->server) return;
  if (impl_->server) impl_->server->stop();
  if (impl_->thread.joinable()) impl_->thread.join();
  impl_->server.reset();
  impl_->running = false;
}

}  // namespace omega::shell
