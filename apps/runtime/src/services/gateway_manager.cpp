#include "omega/runtime/services/gateway_manager.hpp"

#include <httplib.h>

#include <chrono>
#include <regex>
#include <thread>
#include <unordered_set>
#include <vector>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

json default_status(const std::string& id) {
  return json{{"id", id}, {"running", false}, {"messagesIn", 0}, {"messagesOut", 0}};
}

json field(const char* name, const char* label, const char* type = "text") {
  return json{{"name", name}, {"label", label}, {"type", type}};
}

}  // namespace

GatewayManager::GatewayManager(GatewayStore& store, ChatService& chat, ConfigStore& config,
                               EventBus& events)
    : store_(store), chat_(chat), config_(config), events_(events) {}

GatewayManager::~GatewayManager() { stop_all(); }

json GatewayManager::platforms() const {
  return json::array({
      json{{"id", "telegram"},
           {"label", "Telegram"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("botToken", "Bot token", "password")})}},
      json{{"id", "webhook"},
           {"label", "Webhook"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("forwardUrl", "Forward replies to (optional)", "url")})}},
      json{{"id", "discord"},
           {"label", "Discord"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Outbound webhook URL", "url")})}},
      json{{"id", "slack"},
           {"label", "Slack"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Outbound webhook URL", "url")})}},
      json{{"id", "mattermost"},
           {"label", "Mattermost"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Incoming/outgoing webhook URL", "url")})}},
      json{{"id", "matrix"},
           {"label", "Matrix"},
           {"group", "Chat"},
           {"implemented", true},
           {"fields", json::array({field("homeserver", "Homeserver URL", "url"),
                                   field("token", "Access token", "password"),
                                   field("roomId", "Room ID (optional filter)", "text")})}},
      json{{"id", "whatsapp"},
           {"label", "WhatsApp"},
           {"group", "Mobile"},
           {"implemented", true},
           {"fields", json::array({field("apiUrl", "Bridge API URL", "url"),
                                   field("token", "Token (optional)", "password")})}},
      json{{"id", "signal"},
           {"label", "Signal"},
           {"group", "Mobile"},
           {"implemented", true},
           {"fields", json::array({field("apiUrl", "signal-cli REST API (optional outbound)", "url"),
                                   field("phone", "Phone (display)", "text")})}},
      json{{"id", "sms"},
           {"label", "SMS (Twilio)"},
           {"group", "Mobile"},
           {"implemented", true},
           {"fields", json::array({field("accountSid", "Account SID", "text"),
                                   field("token", "Auth token", "password"),
                                   field("fromNumber", "From number", "text")})}},
      json{{"id", "bluebubbles"},
           {"label", "iMessage (BlueBubbles)"},
           {"group", "Mobile"},
           {"implemented", true},
           {"fields", json::array({field("serverUrl", "Server URL", "url"),
                                   field("password", "Password", "password")})}},
      json{{"id", "email"},
           {"label", "Email"},
           {"group", "Office"},
           {"implemented", true},
           {"fields", json::array({field("forwardUrl", "Reply webhook (optional)", "url"),
                                   field("imap", "IMAP (future)", "text")})}},
      json{{"id", "homeassistant"},
           {"label", "Home Assistant"},
           {"group", "IoT"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Notify webhook URL", "url"),
                                   field("token", "Long-lived token (optional)", "password")})}},
      json{{"id", "dingtalk"},
           {"label", "DingTalk"},
           {"group", "Enterprise (CN)"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Bot webhook", "url")})}},
      json{{"id", "feishu"},
           {"label", "Feishu / Lark"},
           {"group", "Enterprise (CN)"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Bot webhook", "url")})}},
      json{{"id", "wecom"},
           {"label", "WeCom"},
           {"group", "Enterprise (CN)"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Bot webhook", "url")})}},
      json{{"id", "weixin"},
           {"label", "Weixin (WeChat Work)"},
           {"group", "Enterprise (CN)"},
           {"implemented", true},
           {"fields", json::array({field("webhookUrl", "Outbound webhook URL", "url"),
                                   field("token", "Corp token (optional)", "password")})}}});
}

json GatewayManager::list_configs() const { return store_.list(); }

json GatewayManager::save_config(const json& cfg) {
  const json saved = store_.save(cfg);
  const std::string id = saved.value("id", "");
  if (saved.value("enabled", false)) {
    start_platform(id);
  } else {
    stop_platform(id);
  }
  return saved;
}

void GatewayManager::delete_config(const std::string& id) {
  store_.remove(id);
  stop_platform(id);
}

json GatewayManager::list_statuses() const {
  std::lock_guard lock(mu_);
  json out = json::array();
  for (const auto& [id, worker] : workers_) {
    (void)id;
    out.push_back(worker->status);
  }
  return out;
}

void GatewayManager::publish_status() {
  events_.publish("omega:gateway:statusChanged", list_statuses());
}

void GatewayManager::patch_status(const std::string& id, const json& patch) {
  {
    std::lock_guard lock(mu_);
    const auto it = workers_.find(id);
    if (it == workers_.end()) return;
    for (auto p = patch.begin(); p != patch.end(); ++p) {
      it->second->status[p.key()] = p.value();
    }
  }
  publish_status();
}

bool GatewayManager::matches_trigger(const json& cfg, const std::string& text,
                                     const std::string& from) const {
  if (cfg.contains("allowList") && cfg["allowList"].is_array() && !cfg["allowList"].empty()) {
    bool allowed = false;
    for (const auto& entry : cfg["allowList"]) {
      if (entry.is_string() && entry.get<std::string>() == from) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return false;
  }
  if (!cfg.contains("trigger") || !cfg["trigger"].is_string()) return true;
  const std::string trigger = cfg["trigger"].get<std::string>();
  if (trigger.empty()) return true;
  try {
    return std::regex_search(text, std::regex(trigger, std::regex::icase));
  } catch (...) {
    return text.find(trigger) != std::string::npos;
  }
}

std::string GatewayManager::reply_with_agent(const json& cfg, const std::string& prompt) {
  std::string model = cfg.value("modelId", "");
  if (model.empty()) {
    const json c = config_.load();
    model = c.value("defaultModel", "");
  }
  if (model.empty()) return "no default model configured";
  const json req{{"model", model},
                 {"messages", json::array({{{"role", "user"}, {"content", prompt}}})},
                 {"sampling", {{"temperature", 0.5}, {"max_tokens", 1024}}},
                 {"agentMode", cfg.value("agentMode", false)}};
  try {
    return chat_.send(req).value("text", "");
  } catch (const std::exception& e) {
    return std::string("error: ") + e.what();
  }
}

void GatewayManager::register_inbound(const std::string& id, InboundHandler handler) {
  std::lock_guard lock(mu_);
  inbound_handlers_[id] = std::move(handler);
}

void GatewayManager::unregister_inbound(const std::string& id) {
  std::lock_guard lock(mu_);
  inbound_handlers_.erase(id);
}

json GatewayManager::handle_inbound(const std::string& id, const json& body) {
  InboundHandler handler;
  {
    std::lock_guard lock(mu_);
    const auto it = inbound_handlers_.find(id);
    if (it == inbound_handlers_.end()) return json{{"ok", false}, {"error", "no handler registered"}};
    handler = it->second;
  }
  return handler(body);
}

void GatewayManager::start_webhook_worker(const json& cfg) {
  const std::string id = cfg.value("id", "webhook");
  register_inbound(id, [this, cfg, id](const json& body) -> json {
    const std::string text = body.value("text", "");
    const std::string from = body.value("from", "webhook");
    if (text.empty()) return json{{"ok", false}};
    if (!matches_trigger(cfg, text, from)) return json{{"ok", false}, {"error", "filtered"}};
    int messages_in = 0;
    {
      std::lock_guard lock(mu_);
      if (workers_.count(id)) messages_in = workers_.at(id)->status.value("messagesIn", 0);
    }
    patch_status(id, json{{"messagesIn", messages_in + 1},
                          {"lastEvent", std::string("webhook: ") + text.substr(0, 60)}});
    const std::string reply = reply_with_agent(cfg, text);
    int messages_out = 0;
    {
      std::lock_guard lock(mu_);
      if (workers_.count(id)) messages_out = workers_.at(id)->status.value("messagesOut", 0);
    }
    patch_status(id, json{{"messagesOut", messages_out + 1}});
    json fields = cfg.value("fields", json::object());
    const std::string forward = fields.value("forwardUrl", "");
    if (!forward.empty()) {
      httplib::Client cli(forward);
      cli.set_connection_timeout(10, 0);
      cli.Post("", json{{"text", reply}}.dump(), "application/json");
    }
    return json{{"reply", reply}};
  });
}

void GatewayManager::start_inbound_webhook_worker(
    const std::string& id,
    std::function<std::pair<std::string, std::string>(const json&)> parse,
    std::function<json(const std::string&)> reply_payload) {
  const json cfg = store_.find(id).value_or(json::object());
  register_inbound(id, [this, id, cfg, parse, reply_payload](const json& body) -> json {
    const auto [text, from] = parse(body);
    if (text.empty()) return json{{"ok", false}};
    if (!matches_trigger(cfg, text, from)) return json{{"ok", false}, {"error", "filtered"}};
    patch_status(id, json{{"messagesIn", 1}, {"lastEvent", from + ": " + text.substr(0, 50)}});
    const std::string reply = reply_with_agent(cfg, text);
    json fields = cfg.value("fields", json::object());
    const std::string url = fields.value("webhookUrl", "");
    if (!url.empty()) {
      httplib::Client cli(url);
      cli.set_connection_timeout(10, 0);
      cli.Post("", reply_payload(reply.substr(0, 4000)).dump(), "application/json");
      patch_status(id, json{{"messagesOut", 1}});
    }
    return json{{"ok", true}, {"reply", reply}};
  });
}

void GatewayManager::start_telegram_worker(const json& cfg) {
  const std::string id = "telegram";
  json fields = cfg.value("fields", json::object());
  const std::string token = fields.value("botToken", "");
  if (token.empty()) throw std::runtime_error("botToken missing");

  auto worker = std::make_unique<WorkerState>();
  worker->cfg = cfg;
  worker->status = default_status(id);
  worker->status["running"] = true;
  worker->stopped = false;

  WorkerState* raw = worker.get();
  {
    std::lock_guard lock(mu_);
    workers_[id] = std::move(worker);
  }
  publish_status();

  raw->poll_thread = std::thread([this, raw, token]() {
    int offset = 0;
    httplib::Client cli("https://api.telegram.org");
    cli.set_connection_timeout(25, 0);
    cli.set_read_timeout(25, 0);
    while (!raw->stopped.load()) {
      try {
        const std::string path =
            "/bot" + token + "/getUpdates?timeout=20&offset=" + std::to_string(offset);
        const auto res = cli.Get(path.c_str());
        if (res && res->status >= 200 && res->status < 300) {
          const json body = json::parse(res->body);
          if (body.value("ok", false) && body.contains("result") && body["result"].is_array()) {
            for (const auto& u : body["result"]) {
              offset = u.value("update_id", offset) + 1;
              if (!u.contains("message") || !u["message"].is_object()) continue;
              const json msg = u["message"];
              const std::string text = msg.value("text", "");
              if (text.empty()) continue;
              std::string from = "unknown";
              if (msg.contains("from") && msg["from"].is_object()) {
                from = msg["from"].value("username", std::to_string(msg["from"].value("id", 0)));
              }
              if (!matches_trigger(raw->cfg, text, from)) continue;
              patch_status("telegram",
                           json{{"messagesIn", raw->status.value("messagesIn", 0) + 1},
                                {"lastEvent", "from " + from + ": " + text.substr(0, 40)}});
              const std::string reply = reply_with_agent(raw->cfg, text);
              const int64_t chat_id = msg.contains("chat") && msg["chat"].is_object()
                                          ? msg["chat"].value("id", 0LL)
                                          : 0LL;
              const json send_body = json{{"chat_id", chat_id}, {"text", reply.substr(0, 4000)}};
              cli.Post(("/bot" + token + "/sendMessage").c_str(), send_body.dump(),
                       "application/json");
              patch_status("telegram",
                           json{{"messagesOut", raw->status.value("messagesOut", 0) + 1}});
            }
          }
        }
      } catch (const std::exception& e) {
        patch_status("telegram", json{{"lastError", e.what()}});
      }
      if (!raw->stopped.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    }
  });
}

void GatewayManager::start_matrix_worker(const json& cfg) {
  const std::string id = "matrix";
  json fields = cfg.value("fields", json::object());
  std::string base = fields.value("homeserver", "");
  while (!base.empty() && base.back() == '/') base.pop_back();
  const std::string token = fields.value("token", "");
  const std::string filter_room = fields.value("roomId", "");
  if (base.empty() || token.empty()) throw std::runtime_error("homeserver and token required");

  auto worker = std::make_unique<WorkerState>();
  worker->cfg = cfg;
  worker->status = default_status(id);
  worker->status["running"] = true;
  worker->stopped = false;
  WorkerState* raw = worker.get();
  {
    std::lock_guard lock(mu_);
    workers_[id] = std::move(worker);
  }
  publish_status();

  raw->poll_thread = std::thread([this, raw, base, token, filter_room]() {
    std::string since;
    std::unordered_set<std::string> seen;
    httplib::Client cli(base);
    cli.set_connection_timeout(25, 0);
    cli.set_read_timeout(25, 0);
    httplib::Headers headers{{"Authorization", "Bearer " + token}};
    while (!raw->stopped.load()) {
      try {
        const std::string path = since.empty()
                                     ? "/_matrix/client/v3/sync?timeout=20000"
                                     : "/_matrix/client/v3/sync?timeout=20000&since=" + since;
        const auto res = cli.Get(path.c_str(), headers);
        if (!res || res->status < 200 || res->status >= 300) continue;
        const json body = json::parse(res->body);
        if (body.contains("next_batch")) since = body["next_batch"].get<std::string>();
        if (body.contains("rooms") && body["rooms"].contains("join") &&
            body["rooms"]["join"].is_object()) {
          for (auto it = body["rooms"]["join"].begin(); it != body["rooms"]["join"].end(); ++it) {
            const std::string room_id = it.key();
            if (!filter_room.empty() && room_id != filter_room) continue;
            if (!it.value().contains("timeline") || !it.value()["timeline"].contains("events")) {
              continue;
            }
            for (const auto& ev : it.value()["timeline"]["events"]) {
              const std::string event_id = ev.value("event_id", "");
              if (event_id.empty() || seen.count(event_id)) continue;
              seen.insert(event_id);
              if (seen.size() > 800) seen.clear();
              if (ev.value("type", "") != "m.room.message") continue;
              const std::string text = ev["content"].value("body", "");
              if (text.empty()) continue;
              const std::string from = ev.value("sender", "matrix");
              if (!matches_trigger(raw->cfg, text, from)) continue;
              const std::string reply = reply_with_agent(raw->cfg, text);
              const std::string txn = "omega-" + std::to_string(
                  std::chrono::steady_clock::now().time_since_epoch().count());
              const std::string send_path = "/_matrix/client/v3/rooms/" + room_id +
                                            "/send/m.room.message/" + txn;
              cli.Put(send_path.c_str(), headers,
                      json{{"msgtype", "m.text"}, {"body", reply.substr(0, 4000)}}.dump(),
                      "application/json");
            }
          }
        }
      } catch (...) {
      }
      if (!raw->stopped.load()) std::this_thread::sleep_for(std::chrono::milliseconds(400));
    }
  });
}

void GatewayManager::start_bluebubbles_worker(const json& cfg) {
  const std::string id = "bluebubbles";
  json fields = cfg.value("fields", json::object());
  std::string base = fields.value("serverUrl", "");
  while (!base.empty() && base.back() == '/') base.pop_back();
  const std::string password = fields.value("password", "");
  if (base.empty()) throw std::runtime_error("serverUrl missing");

  auto worker = std::make_unique<WorkerState>();
  worker->cfg = cfg;
  worker->status = default_status(id);
  worker->status["running"] = true;
  worker->stopped = false;
  WorkerState* raw = worker.get();
  {
    std::lock_guard lock(mu_);
    workers_[id] = std::move(worker);
  }
  publish_status();

  raw->poll_thread = std::thread([this, raw, base, password]() {
    httplib::Client cli(base);
    cli.set_connection_timeout(10, 0);
    cli.set_read_timeout(10, 0);
    while (!raw->stopped.load()) {
      try {
        const std::string path =
            "/api/v1/message/text?password=" + password + "&limit=5";
        const auto res = cli.Get(path.c_str());
        if (res && res->status >= 200 && res->status < 300) {
          const json body = json::parse(res->body);
          for (const auto& msg : body.value("data", json::array())) {
            const std::string text = msg.value("text", "");
            if (text.empty()) continue;
            const std::string from = msg.value("handle", "imessage");
            if (!matches_trigger(raw->cfg, text, from)) continue;
            const std::string reply = reply_with_agent(raw->cfg, text);
            cli.Post(("/api/v1/message/text?password=" + password).c_str(),
                     json{{"chatGuid", from}, {"message", reply.substr(0, 4000)}}.dump(),
                     "application/json");
          }
        }
      } catch (...) {
      }
      if (!raw->stopped.load()) std::this_thread::sleep_for(std::chrono::milliseconds(4000));
    }
  });
}

json GatewayManager::start_platform(const std::string& id) {
  const auto cfg_opt = store_.find(id);
  if (!cfg_opt) return json();
  const json cfg = *cfg_opt;
  if (!cfg.value("enabled", false)) return json();

  stop_platform(id);

  try {
    if (id == "telegram") {
      start_telegram_worker(cfg);
    } else if (id == "webhook") {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
      start_webhook_worker(cfg);
    } else if (id == "discord" || id == "slack" || id == "mattermost" || id == "dingtalk" ||
               id == "feishu" || id == "wecom" || id == "homeassistant" || id == "whatsapp" ||
               id == "weixin") {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
      if (id == "discord") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              const std::string text = b.value("content", "");
              const std::string from =
                  b.contains("author") && b["author"].is_object()
                      ? b["author"].value("username", "discord")
                      : "discord";
              return std::pair{text, from};
            },
            [](const std::string& t) { return json{{"content", t.substr(0, 1900)}}; });
      } else if (id == "slack") {
        start_inbound_webhook_worker(
            id, [](const json& b) { return std::pair{b.value("text", ""), b.value("user_name", "slack")}; },
            [](const std::string& t) { return json{{"text", t.substr(0, 3000)}}; });
      } else if (id == "mattermost") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) { return std::pair{b.value("text", ""), b.value("user_name", "mattermost")}; },
            [](const std::string& t) { return json{{"text", t}}; });
      } else if (id == "dingtalk") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              std::string text;
              if (b.contains("text") && b["text"].is_object()) {
                text = b["text"].value("content", "");
              } else {
                text = b.value("content", "");
              }
              return std::pair{text, std::string("dingtalk")};
            },
            [](const std::string& t) { return json{{"msgtype", "text"}, {"text", {{"content", t}}}}; });
      } else if (id == "feishu") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              std::string text = b.value("text", "");
              if (text.empty() && b.contains("event") && b["event"].is_object()) {
                text = b["event"]["message"].value("content", "");
              }
              std::string from = "feishu";
              if (b.contains("event") && b["event"].is_object() && b["event"].contains("sender")) {
                from = b["event"]["sender"]["sender_id"].value("user_id", from);
              }
              return std::pair{text, from};
            },
            [](const std::string& t) { return json{{"msg_type", "text"}, {"content", {{"text", t}}}}; });
      } else if (id == "wecom") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              std::string text;
              if (b.contains("text") && b["text"].is_object()) {
                text = b["text"].value("content", "");
              } else {
                text = b.value("content", "");
              }
              return std::pair{text, std::string("wecom")};
            },
            [](const std::string& t) { return json{{"msgtype", "text"}, {"text", {{"content", t}}}}; });
      } else if (id == "homeassistant") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              return std::pair{b.value("message", b.value("text", "")),
                               b.value("user", "homeassistant")};
            },
            [](const std::string& t) { return json{{"message", t}}; });
      } else if (id == "whatsapp") {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              return std::pair{b.value("body", b.value("text", "")), b.value("from", "whatsapp")};
            },
            [](const std::string& t) { return json{{"message", t}}; });
      } else {
        start_inbound_webhook_worker(
            id,
            [](const json& b) {
              std::string text;
              if (b.contains("text") && b["text"].is_object()) {
                text = b["text"].value("content", "");
              } else {
                text = b.value("Content", "");
              }
              return std::pair{text, b.value("FromUserName", "weixin")};
            },
            [](const std::string& t) {
              return json{{"msgtype", "text"}, {"text", {{"content", t.substr(0, 2000)}}}};
            });
      }
    } else if (id == "signal") {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
      register_inbound(id, [this, cfg](const json& body) -> json {
        std::string text = body.value("message", "");
        std::string from = body.value("source", "signal");
        if (text.empty() && body.contains("envelope") && body["envelope"].is_object()) {
          const json env = body["envelope"];
          from = env.value("source", from);
          text = env["dataMessage"].value("message", "");
        }
        if (text.empty()) return json{{"ok", false}};
        if (!matches_trigger(cfg, text, from)) return json{{"ok", false}, {"error", "filtered"}};
        patch_status("signal", json{{"messagesIn", 1}, {"lastEvent", from + ": " + text.substr(0, 40)}});
        const std::string reply = reply_with_agent(cfg, text);
        json fields = cfg.value("fields", json::object());
        const std::string api = fields.value("apiUrl", "");
        if (!api.empty()) {
          httplib::Client cli(api);
          cli.set_connection_timeout(10, 0);
          cli.Post("/v2/send", json{{"number", from}, {"message", reply.substr(0, 4000)}}.dump(),
                   "application/json");
          patch_status("signal", json{{"messagesOut", 1}});
        }
        return json{{"ok", true}, {"reply", reply}};
      });
    } else if (id == "email") {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
      register_inbound(id, [this, cfg](const json& body) -> json {
        const std::string from = body.value("from", body.value("sender", "email"));
        std::string text = body.value("subject", "");
        const std::string body_text =
            body.value("text", body.value("stripped-text", body.value("body", "")));
        if (!body_text.empty()) {
          if (!text.empty()) text += "\n";
          text += body_text;
        }
        if (text.empty()) return json{{"ok", false}};
        if (!matches_trigger(cfg, text, from)) return json{{"ok", false}, {"error", "filtered"}};
        const std::string reply = reply_with_agent(cfg, text);
        json fields = cfg.value("fields", json::object());
        const std::string forward = fields.value("forwardUrl", "");
        if (!forward.empty()) {
          httplib::Client cli(forward);
          cli.Post("", json{{"to", from}, {"subject", "Re: Omega"}, {"text", reply}}.dump(),
                   "application/json");
        }
        return json{{"ok", true}, {"reply", reply}};
      });
    } else if (id == "sms") {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
      register_inbound(id, [this, cfg](const json& body) -> json {
        const std::string from = body.value("From", "");
        const std::string text = body.value("Body", "");
        if (from.empty() || text.empty()) return json{{"ok", false}};
        if (!matches_trigger(cfg, text, from)) return json{{"ok", false}, {"error", "filtered"}};
        const std::string reply = reply_with_agent(cfg, text);
        json fields = cfg.value("fields", json::object());
        const std::string sid = fields.value("accountSid", "");
        const std::string token = fields.value("token", "");
        const std::string from_number = fields.value("fromNumber", "");
        if (!sid.empty() && !token.empty()) {
          httplib::Client cli("https://api.twilio.com");
          cli.set_connection_timeout(15, 0);
          const std::string form =
              "To=" + from + "&From=" + from_number + "&Body=" + reply.substr(0, 1600);
          cli.Post(("/2010-04-01/Accounts/" + sid + "/Messages.json").c_str(), form,
                   "application/x-www-form-urlencoded");
        }
        return json{{"ok", true}, {"reply", reply}};
      });
    } else if (id == "matrix") {
      start_matrix_worker(cfg);
    } else if (id == "bluebubbles") {
      start_bluebubbles_worker(cfg);
    } else {
      auto worker = std::make_unique<WorkerState>();
      worker->cfg = cfg;
      worker->status = default_status(id);
      worker->status["running"] = true;
      worker->status["lastError"] = "platform polling not yet ported to native runtime";
      {
        std::lock_guard lock(mu_);
        workers_[id] = std::move(worker);
      }
    }
  } catch (const std::exception& e) {
    patch_status(id, json{{"running", false}, {"lastError", e.what()}});
  }

  publish_status();
  std::lock_guard lock(mu_);
  const auto it = workers_.find(id);
  return it != workers_.end() ? it->second->status : json();
}

void GatewayManager::stop_platform(const std::string& id) {
  std::unique_ptr<WorkerState> worker;
  {
    std::lock_guard lock(mu_);
    const auto it = workers_.find(id);
    if (it != workers_.end()) {
      it->second->stopped = true;
      worker = std::move(it->second);
      workers_.erase(it);
    }
    inbound_handlers_.erase(id);
  }
  if (worker && worker->poll_thread.joinable()) worker->poll_thread.join();
  publish_status();
}

void GatewayManager::start_all_enabled() {
  for (const auto& cfg : store_.list()) {
    if (cfg.value("enabled", false)) start_platform(cfg.value("id", ""));
  }
}

void GatewayManager::stop_all() {
  std::vector<std::string> ids;
  {
    std::lock_guard lock(mu_);
    for (const auto& [id, _] : workers_) ids.push_back(id);
  }
  for (const auto& id : ids) stop_platform(id);
}

}  // namespace omega::runtime
