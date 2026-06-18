#include "omega/runtime/services/content_job_delivery_service.hpp"

#include "omega/runtime/debug_log.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/services/debug_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/model_load_payload.hpp"
#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/services/content_studio_native_status.hpp"
#include "omega/runtime/services/media_player_service.hpp"
#include "omega/runtime/chat/message_media.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/storage/project_store.hpp"
#include "omega/runtime/storage/session_store.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <thread>

namespace fs = std::filesystem;
namespace omega::runtime {

using json = nlohmann::json;

namespace {

constexpr int64_t kCacheTtlMs = 4 * 60 * 60 * 1000;

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string short_error_for_card(const std::string& hint) {
  if (hint.empty()) return hint;
  std::string out = hint;
  const size_t nl = out.find('\n');
  if (nl != std::string::npos) out = out.substr(0, nl);
  while (!out.empty() && (out.back() == ' ' || out.back() == '\r')) out.pop_back();
  if (out.size() > 280) out = out.substr(0, 277) + "...";
  return out;
}

bool is_success_status(const std::string& status) {
  const std::string s = status;
  std::string lower = s;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return lower == "succeeded" || lower == "completed";
}

bool is_terminal_status(const std::string& status) {
  const std::string s = status;
  std::string lower = s;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return is_success_status(lower) || lower == "failed" || lower == "cancelled" || lower == "canceled";
}

json upsert_content_studio_part(json parts, const json& card) {
  if (!parts.is_array()) parts = json::array();
  json out = json::array();
  for (const auto& p : parts) {
    if (p.value("type", "") != "content_studio") out.push_back(p);
  }
  out.push_back(card);
  return out;
}

json upsert_direct_video_part(json parts, const json& card) {
  if (!parts.is_array()) parts = json::array();
  json out = json::array();
  for (const auto& p : parts) {
    if (p.value("type", "") != "direct_video") out.push_back(p);
  }
  out.push_back(card);
  return out;
}

json dedupe_parts(json parts) {
  if (!parts.is_array()) return json::array();
  json out = json::array();
  std::unordered_map<std::string, size_t> cs_by_job;
  std::unordered_map<std::string, size_t> media_by_ref;
  std::unordered_map<std::string, size_t> choices_by_prompt;
  for (const auto& p : parts) {
    if (!p.is_object()) continue;
    const std::string type = p.value("type", "");
    if (type == "content_studio" || type == "direct_video") {
      const std::string jid = p.value("jobId", "");
      const auto it = cs_by_job.find(jid);
      if (it == cs_by_job.end()) {
        cs_by_job[jid] = out.size();
        out.push_back(p);
      } else {
        out[it->second] = p;
      }
      continue;
    }
    if (type == "video" || type == "audio" || type == "image") {
      const std::string key = type + ":" + p.value("ref", "");
      const auto it = media_by_ref.find(key);
      if (it == media_by_ref.end()) {
        media_by_ref[key] = out.size();
        out.push_back(p);
      } else {
        out[it->second] = p;
      }
      continue;
    }
    if (type == "choices") {
      std::string prompt = p.value("prompt", "");
      for (auto& c : prompt) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      const auto it = choices_by_prompt.find(prompt);
      if (it == choices_by_prompt.end()) {
        choices_by_prompt[prompt] = out.size();
        out.push_back(p);
      } else {
        out[it->second] = p;
      }
      continue;
    }
    out.push_back(p);
  }
  return out;
}

std::string hash_file_prefix(const fs::path& path) {
  std::error_code ec;
  const auto sz = fs::file_size(path, ec);
  const auto mtime = fs::last_write_time(path, ec);
  std::ostringstream ss;
  ss << std::hex << (sz & 0xFFFFFFFFFFFFFULL) << (mtime.time_since_epoch().count() & 0xFFFF);
  std::string id = ss.str();
  if (id.size() < 8) id = random_uuid().substr(0, 16);
  return id.substr(0, 16);
}

std::optional<std::string> job_final_mp4_relative(const std::string& project_id,
                                                  const std::string& job_id) {
  if (project_id.empty() || job_id.empty()) return std::nullopt;
  const fs::path path =
      fs::path(resolve_content_studio_storage()) / project_id / job_id / "final.mp4";
  std::error_code ec;
  if (!fs::exists(path, ec) || !fs::is_regular_file(path, ec)) return std::nullopt;
  if (fs::file_size(path, ec) < 512) return std::nullopt;
  std::string rel = project_id + "/" + job_id + "/final.mp4";
  for (char& c : rel) {
    if (c == '\\') c = '/';
  }
  return rel;
}

std::string resolve_job_display_status(const std::string& raw_status, bool worker_running,
                                       bool video_ready, const std::string& project_id,
                                       const std::string& job_id) {
  if (job_final_mp4_relative(project_id, job_id)) {
    if (worker_running || raw_status == "running" || raw_status == "queued") return "running";
    if (is_success_status(raw_status)) return raw_status;
    return "succeeded";
  }
  std::string display = raw_status;
  if (worker_running && is_success_status(raw_status)) display = "running";
  if (is_success_status(raw_status) && !worker_running && !video_ready) display = "failed";
  return display;
}

}  // namespace

void ContentJobDeliveryService::attach(SessionStore* sessions, ProjectStore* projects,
                                       ProfileContext* profile,
                                       ContentStudioSupervisor* content_studio,
                                       EngineClient* engine, EventBus* events,
                                       ConfigStore* config, ContentStudioSettings* cs_settings,
                                       MediaPlayerService* media_player) {
  sessions_ = sessions;
  projects_ = projects;
  profile_ = profile;
  content_studio_ = content_studio;
  engine_ = engine;
  events_ = events;
  config_ = config;
  cs_settings_ = cs_settings;
  media_player_ = media_player;
}

void ContentJobDeliveryService::attach_debug(DebugStore* debug) { debug_ = debug; }

void ContentJobDeliveryService::set_runtime_status_publisher(
    std::function<void(const std::string& reason)> publisher) {
  runtime_status_publisher_ = std::move(publisher);
}

void ContentJobDeliveryService::set_chat_model_reloader(
    std::function<void(const std::string& model_id, const std::string& job_id)> reloader) {
  chat_model_reloader_ = std::move(reloader);
}

void ContentJobDeliveryService::publish_runtime_model_status(const std::string& reason) {
  if (runtime_status_publisher_) {
    runtime_status_publisher_(reason);
    return;
  }
  if (!engine_ || !events_) return;
  try {
    engine_->ensure_started();
    json status{{"state", "ready"}};
    const json loaded = engine_->command("model.loaded", json::object(), 30000);
    if (loaded.contains("models") && loaded["models"].is_array()) {
      status["loadedModels"] = loaded["models"];
    }
    std::string active = loaded.value("activeModelId", "");
    if (!active.empty()) {
      status["activeModel"] = active;
      status["nativeLoaded"] = active;
    }
    status["reason"] = reason;
    events_->publish("omega:runtime:status-changed", status);
  } catch (...) {
  }
}

void ContentJobDeliveryService::cs_log(const std::string& message, const std::string& level,
                                       const json& data) const {
  emit_debug(debug_, "delivery", message, level, data);
}

json ContentJobDeliveryService::handle_webhook(const json& body, EventBus& events) {
  const std::string job_id = body.value("job_id", body.value("jobId", ""));
  if (job_id.empty()) return json{{"ok", false}, {"error", "job_id required"}};

  {
    std::lock_guard lock(mu_);
    if (cancelled_.count(job_id) || delivered_.count(job_id)) {
      return json{{"ok", true}, {"job_id", job_id}, {"ignored", true}};
    }
  }

  const std::string status = body.value("status", "unknown");
  cs_log("webhook job=" + job_id + " status=" + status, "info", json{{"job_id", job_id}, {"status", status}});
  const std::string mp4 = body.contains("video") && body["video"].is_object()
                              ? body["video"].value("mp4_path", body["video"].value("mp4Path", ""))
                              : "";

  json cached = json{{"status",
                      json{{"job_id", job_id},
                           {"project_id", body.value("project_id", body.value("projectId", ""))},
                           {"status", status},
                           {"worker_running", false},
                           {"video_ready", is_success_status(status) && !mp4.empty()},
                           {"youtube_url", body.contains("video") ? body["video"].value("youtube_url", nullptr) : nullptr}}},
                     {"mp4Relative", mp4},
                     {"receivedAt", now_ms()}};

  {
    std::lock_guard lock(mu_);
    cache_[job_id] = cached;
    const std::string project_id = body.value("project_id", body.value("projectId", ""));
    if (!project_id.empty()) project_by_job_[job_id] = project_id;
  }

  events.publish("omega:content-studio:webhook",
                 json{{"job_id", job_id}, {"status", status}, {"body", body}});

  if (is_terminal_status(status)) {
    try_finalize_delivery(job_id, body, events);
  }

  return json{{"ok", true}, {"job_id", job_id}, {"status", status}};
}

json ContentJobDeliveryService::register_job(const json& body) {
  const std::string job_id = body.value("jobId", body.value("job_id", ""));
  const std::string session_id = body.value("sessionId", body.value("session_id", ""));
  const std::string project_id = body.value("projectId", body.value("project_id", ""));
  if (job_id.empty()) return json{{"ok", false}, {"error", "jobId required"}};
  {
    std::lock_guard lock(mu_);
    if (!session_id.empty()) session_by_job_[job_id] = session_id;
    if (!project_id.empty()) project_by_job_[job_id] = project_id;
  }
  return json{{"ok", true}, {"jobId", job_id}, {"sessionId", session_id}, {"projectId", project_id}};
}

void ContentJobDeliveryService::track_job(const std::string& job_id,
                                          const std::string& session_id,
                                          const std::string& project_id) {
  if (job_id.empty() || session_id.empty() || project_id.empty()) return;
  cs_log("track_job job=" + job_id, "info",
         json{{"job_id", job_id}, {"session_id", session_id}, {"project_id", project_id}});
  register_job(json{{"jobId", job_id}, {"sessionId", session_id}, {"projectId", project_id}});
  {
    std::lock_guard lock(mu_);
    const auto it = reload_after_job_.find(session_id);
    if (it != reload_after_job_.end()) {
      reload_by_job_[job_id] = it->second;
    }
  }
  start_watcher(job_id, session_id, project_id);
}

void ContentJobDeliveryService::track_direct_video_job(const std::string& job_id,
                                                       const std::string& session_id) {
  if (job_id.empty() || session_id.empty()) return;
  cs_log("track_direct_t2v job=" + job_id, "info",
         json{{"job_id", job_id}, {"session_id", session_id}});
  register_job(json{{"jobId", job_id}, {"sessionId", session_id}});
}

json ContentJobDeliveryService::ensure_card(const json& body, EventBus& events) {
  const std::string job_id = body.value("jobId", body.value("job_id", ""));
  const std::string session_id = body.value("sessionId", body.value("session_id", ""));
  const std::string project_id = body.value("projectId", body.value("project_id", ""));
  const std::string status = body.value("status", "queued");
  if (job_id.empty() || session_id.empty() || project_id.empty()) {
    return json{{"ok", false}, {"error", "jobId, sessionId, projectId required"}};
  }
  register_job(body);
  if (!sessions_) return json{{"ok", false}, {"error", "session store unavailable"}};

  const json card = json{{"type", "content_studio"},
                         {"jobId", job_id},
                         {"projectId", project_id},
                         {"status", status},
                         {"title", body.value("title", "Content Studio")},
                         {"startedAt", now_ms()}};

  std::optional<PatchResult> patch;
  if (auto by_job = patch_job_message(session_id, job_id, [&](json& parts, std::string& content) {
        parts = upsert_content_studio_part(parts, card);
        (void)content;
      })) {
    patch = *by_job;
  } else if (sessions_) {
    const auto latest = sessions_->patch_latest_assistant_message(
        session_id, [&](json& parts, std::string& content) {
          parts = upsert_content_studio_part(parts, card);
          (void)content;
        });
    if (latest) {
      PatchResult created;
      created.content = latest->content;
      created.parts = latest->parts;
      created.message_index = latest->message_index;
      patch = created;
    }
  }

  if (patch) {
    publish_assistant_patch(events, session_id, job_id, *patch);
    start_watcher(job_id, session_id, project_id);
    return json{{"ok", true}, {"messageIndex", patch->message_index}};
  }

  sessions_->append_message(session_id, "assistant", "", json{{"parts", json::array({card})}});
  const json msgs = sessions_->get_messages(session_id);
  const int idx = msgs.is_array() ? static_cast<int>(msgs.size()) - 1 : -1;
  PatchResult created;
  created.content = "";
  created.parts = json::array({card});
  created.message_index = idx;
  publish_assistant_patch(events, session_id, job_id, created);
  start_watcher(job_id, session_id, project_id);
  return json{{"ok", true}, {"messageIndex", idx}, {"created", true}};
}

std::optional<json> ContentJobDeliveryService::get_cached(const std::string& job_id) const {
  std::lock_guard lock(mu_);
  const auto it = cache_.find(job_id);
  if (it == cache_.end()) return std::nullopt;
  const int64_t received = it->second.value("receivedAt", static_cast<int64_t>(0));
  if (now_ms() - received > kCacheTtlMs) return std::nullopt;
  return it->second;
}

void ContentJobDeliveryService::register_session(const std::string& job_id,
                                                 const std::string& session_id) {
  if (job_id.empty() || session_id.empty()) return;
  std::lock_guard lock(mu_);
  session_by_job_[job_id] = session_id;
}

void ContentJobDeliveryService::clear_job(const std::string& job_id) {
  stop_watcher(job_id);
  std::lock_guard lock(mu_);
  cache_.erase(job_id);
  session_by_job_.erase(job_id);
  project_by_job_.erase(job_id);
  cancelled_.insert(job_id);
}

void ContentJobDeliveryService::stop_watcher(const std::string& job_id) {
  std::shared_ptr<std::atomic<bool>> stop;
  std::thread worker;
  {
    std::lock_guard lock(watch_mu_);
    const auto sit = watcher_stop_.find(job_id);
    if (sit != watcher_stop_.end()) stop = sit->second;
    const auto tit = watcher_threads_.find(job_id);
    if (tit != watcher_threads_.end()) {
      worker = std::move(tit->second);
      watcher_threads_.erase(tit);
    }
    watcher_stop_.erase(job_id);
  }
  if (stop) stop->store(true);
  if (!worker.joinable()) return;
  // Watcher thread calls try_finalize → stop_watcher for the same job; joining self deadlocks.
  if (worker.get_id() == std::this_thread::get_id()) {
    worker.detach();
    return;
  }
  worker.join();
}

void ContentJobDeliveryService::drop_watcher(const std::string& job_id) {
  std::shared_ptr<std::atomic<bool>> stop;
  std::thread worker;
  {
    std::lock_guard lock(watch_mu_);
    const auto sit = watcher_stop_.find(job_id);
    if (sit != watcher_stop_.end()) stop = sit->second;
    const auto tit = watcher_threads_.find(job_id);
    if (tit != watcher_threads_.end()) {
      worker = std::move(tit->second);
      watcher_threads_.erase(tit);
    }
    watcher_stop_.erase(job_id);
  }
  if (stop) stop->store(true);
  if (worker.joinable()) worker.detach();
}

void ContentJobDeliveryService::schedule_chat_model_reload_async(const std::string& model_id,
                                                                 const std::string& job_id) {
  if (!chat_model_reloader_) {
    cs_log("chat reload skipped — reloader not wired", "error",
           json{{"job_id", job_id}, {"model_id", model_id}});
    return;
  }
  if (model_id.empty()) {
    cs_log("chat reload skipped — empty model id", "error", json{{"job_id", job_id}});
    return;
  }
  cs_log("scheduling chat model reload", "info", json{{"job_id", job_id}, {"model_id", model_id}});
  auto reloader = chat_model_reloader_;
  std::thread([this, reloader, model_id, job_id]() {
    wait_for_job_gpu_release(job_id);
    try {
      reloader(model_id, job_id);
      cs_log("chat model reload finished job=" + job_id, "info",
             json{{"job_id", job_id}, {"model_id", model_id}});
    } catch (const std::exception& e) {
      cs_log(std::string("chat model reload failed: ") + e.what(), "error",
             json{{"job_id", job_id}, {"model_id", model_id}});
    } catch (...) {
      cs_log("chat model reload failed job=" + job_id, "error",
             json{{"job_id", job_id}, {"model_id", model_id}});
    }
  }).detach();
}

std::string ContentJobDeliveryService::resolve_reload_model_id(const ReloadMeta* meta) const {
  if (meta && !meta->model_id.empty()) return meta->model_id;
  if (cs_settings_) {
    const std::string id = cs_settings_->load_generation().value("omegaModelId", "");
    if (!id.empty()) return id;
  }
  if (config_) return config_->load().value("defaultModel", "");
  return {};
}

void ContentJobDeliveryService::schedule_post_cs_chat_reload_if_needed(
    const std::string& session_id, const std::string& job_id, const std::string& status) {
  std::string lower = status;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (lower == "cancelled" || lower == "canceled") return;

  bool session_unloaded = false;
  bool need_reload = false;
  const ReloadMeta* meta_ptr = nullptr;
  ReloadMeta meta_copy;
  {
    std::lock_guard lock(mu_);
    if (reload_scheduled_jobs_.count(job_id)) return;
    session_unloaded = sessions_chat_unloaded_.count(session_id) > 0;
    if (const auto jit = reload_by_job_.find(job_id); jit != reload_by_job_.end()) {
      meta_copy = jit->second;
      meta_ptr = &meta_copy;
      need_reload = meta_copy.unloaded_chat_model;
    } else if (const auto sit = reload_after_job_.find(session_id); sit != reload_after_job_.end()) {
      meta_copy = sit->second;
      meta_ptr = &meta_copy;
      need_reload = meta_copy.unloaded_chat_model;
    }
  }
  if (!need_reload && !session_unloaded) return;

  const std::string model_id = resolve_reload_model_id(meta_ptr);
  if (model_id.empty()) {
    cs_log("post-CS chat reload skipped — no model id configured", "error",
           json{{"job_id", job_id},
                {"session_id", session_id},
                {"session_unload_flag", session_unloaded}});
    return;
  }

  {
    std::lock_guard lock(mu_);
    reload_scheduled_jobs_.insert(job_id);
    sessions_chat_unloaded_.erase(session_id);
  }
  cs_log("post-CS chat reload scheduled early", "info",
         json{{"job_id", job_id},
              {"session_id", session_id},
              {"model_id", model_id},
              {"session_unload_flag", session_unloaded},
              {"had_reload_meta", meta_ptr != nullptr}});
  schedule_chat_model_reload_async(model_id, job_id);
}

void ContentJobDeliveryService::start_watcher(const std::string& job_id,
                                              const std::string& session_id,
                                              const std::string& project_id) {
  if (!content_studio_ || !events_) return;
  stop_watcher(job_id);

  auto stop = std::make_shared<std::atomic<bool>>(false);
  {
    std::lock_guard lock(watch_mu_);
    watcher_stop_[job_id] = stop;
  }

  std::thread worker([this, job_id, session_id, project_id, stop]() {
    try {
      content_studio_->ensure_started();
    } catch (...) {
      return;
    }

    std::string last_display;
    for (int i = 0; i < 300 && !stop->load(); ++i) {
      {
        std::lock_guard lock(mu_);
        if (delivered_.count(job_id) || cancelled_.count(job_id)) return;
      }

      try {
        json st;
        if (const auto native = get_content_studio_run_status_native(job_id)) {
          st = *native;
        } else {
          st = content_studio_->api("GET", "/api/agent/v1/runs/" + job_id);
        }
        const std::string raw_status = st.value("status", "unknown");
        const bool worker_running = st.value("worker_running", false);
        const bool video_ready = st.value("video_ready", false);

        if (const auto mp4_rel = job_final_mp4_relative(project_id, job_id)) {
          if (!worker_running && (is_terminal_status(raw_status) || video_ready)) {
            json body = json{{"job_id", job_id},
                             {"project_id", project_id},
                             {"status", "succeeded"},
                             {"video", json{{"mp4_path", *mp4_rel}}}};
            cs_log("watcher finalize from disk job=" + job_id, "info",
                   json{{"job_id", job_id}, {"mp4", *mp4_rel}});
            try_finalize_delivery(job_id, body, *events_);
            return;
          }
        }

        const std::string display =
            resolve_job_display_status(raw_status, worker_running, video_ready, project_id, job_id);
        if (display != last_display) {
          last_display = display;
          cs_log("watcher status job=" + job_id + " → " + display, "info",
                 json{{"job_id", job_id}, {"status", display}, {"worker_running", worker_running},
                      {"video_ready", video_ready}});
          update_job_card(session_id, job_id, project_id, display, st, *events_);
        }

        if (is_terminal_status(raw_status) && !worker_running) {
          std::string mp4_rel = st.value("mp4_path", st.value("mp4Path", ""));
          if (mp4_rel.empty() && st.contains("video") && st["video"].is_object()) {
            mp4_rel = st["video"].value("mp4_path", st["video"].value("mp4Path", ""));
          }
          if (!mp4_rel.empty()) {
            std::lock_guard lock(mu_);
            json& cached = cache_[job_id];
            if (!cached.is_object()) cached = json::object();
            cached["mp4Relative"] = mp4_rel;
            cached["receivedAt"] = now_ms();
          }
          json body = json{{"job_id", job_id},
                           {"project_id", project_id},
                           {"status", raw_status}};
          if (st.contains("video") && st["video"].is_object()) {
            body["video"] = st["video"];
          } else if (!mp4_rel.empty()) {
            body["video"] = json{{"mp4_path", mp4_rel}};
          }
          try_finalize_delivery(job_id, body, *events_);
          return;
        }
      } catch (...) {
        // Do not finalize from disk while the worker may still be running — wait for terminal status.
      }

      std::this_thread::sleep_for(std::chrono::seconds(6));
    }
  });

  {
    std::lock_guard lock(watch_mu_);
    watcher_threads_[job_id] = std::move(worker);
  }
}

void ContentJobDeliveryService::update_job_card(const std::string& session_id,
                                                const std::string& job_id,
                                                const std::string& project_id,
                                                const std::string& status,
                                                const json& run_status, EventBus& events) {
  if (!sessions_) return;
  const json card = json{{"type", "content_studio"},
                         {"jobId", job_id},
                         {"projectId", project_id},
                         {"status", status},
                         {"title", "Content Studio"},
                         {"youtubeUrl", run_status.contains("youtube_url")
                                            ? run_status.value("youtube_url", nullptr)
                                            : nullptr}};
  const auto patch = patch_job_message(session_id, job_id, [&](json& parts, std::string& content) {
    parts = upsert_content_studio_part(parts, card);
    (void)content;
  });
  if (patch) publish_assistant_patch(events, session_id, job_id, *patch);
}

void ContentJobDeliveryService::cancel_active_jobs_for_session(const std::string& session_id) {
  if (session_id.empty()) return;

  std::unordered_set<std::string> job_ids;
  {
    std::lock_guard lock(mu_);
    for (const auto& [job_id, sid] : session_by_job_) {
      if (sid != session_id) continue;
      if (delivered_.count(job_id) || cancelled_.count(job_id)) continue;
      job_ids.insert(job_id);
    }
  }

  if (sessions_) {
    try {
      const json msgs = sessions_->get_messages(session_id);
      if (msgs.is_array()) {
        for (const auto& m : msgs) {
          if (m.value("role", "") != "assistant") continue;
          json parts = m.contains("parts") ? m["parts"] : json::array();
          if (!parts.is_array()) continue;
          for (const auto& p : parts) {
            if (p.value("type", "") != "content_studio") continue;
            const std::string jid = p.value("jobId", "");
            if (!jid.empty()) job_ids.insert(jid);
          }
          for (const auto& p : parts) {
            if (p.value("type", "") != "direct_video") continue;
            const std::string jid = p.value("jobId", "");
            if (!jid.empty()) job_ids.insert(jid);
          }
        }
      }
    } catch (...) {
    }

    sessions_->strip_content_studio_parts(session_id);
  }

  for (const std::string& job_id : job_ids) {
    if (content_studio_) {
      try {
        content_studio_->cancel_run(job_id);
      } catch (...) {
      }
    }
    stop_watcher(job_id);
    std::lock_guard lock(mu_);
    cancelled_.insert(job_id);
    cache_.erase(job_id);
    session_by_job_.erase(job_id);
    project_by_job_.erase(job_id);
  }
}

void ContentJobDeliveryService::purge_session(const std::string& session_id) {
  if (session_id.empty()) return;
  cancel_active_jobs_for_session(session_id);

  std::vector<std::string> tracked_jobs;
  {
    std::lock_guard lock(mu_);
    reload_after_job_.erase(session_id);
    sessions_chat_unloaded_.erase(session_id);
    for (const auto& [job_id, sid] : session_by_job_) {
      if (sid == session_id) tracked_jobs.push_back(job_id);
    }
  }

  for (const std::string& job_id : tracked_jobs) {
    stop_watcher(job_id);
    std::lock_guard lock(mu_);
    cancelled_.insert(job_id);
    cache_.erase(job_id);
    reload_by_job_.erase(job_id);
    session_by_job_.erase(job_id);
    project_by_job_.erase(job_id);
  }
}

void ContentJobDeliveryService::prepare_max_performance_job(const std::string& session_id,
                                                            const std::string& model_id,
                                                            const std::string& title,
                                                            const std::string& theme) {
  std::string resolved = model_id;
  if (resolved.empty() && cs_settings_) {
    resolved = cs_settings_->load_generation().value("omegaModelId", "");
  }
  if (resolved.empty() && config_) {
    resolved = config_->load().value("defaultModel", "");
  }
  release_chat_model_for_content_studio(resolved);
  remember_reload_after_job(session_id, resolved, title, theme, true);
  {
    std::lock_guard lock(mu_);
    sessions_chat_unloaded_.insert(session_id);
  }
}

void ContentJobDeliveryService::remember_reload_after_job(const std::string& session_id,
                                                          const std::string& model_id,
                                                          const std::string& title,
                                                          const std::string& theme,
                                                          bool unloaded_chat_model) {
  if (session_id.empty()) return;
  std::string resolved = model_id;
  if (resolved.empty() && cs_settings_) {
    resolved = cs_settings_->load_generation().value("omegaModelId", "");
  }
  if (resolved.empty() && config_) {
    resolved = config_->load().value("defaultModel", "");
  }
  ReloadMeta meta;
  meta.model_id = resolved;
  meta.title = title;
  meta.theme = theme;
  meta.unloaded_chat_model = unloaded_chat_model;
  std::lock_guard lock(mu_);
  reload_after_job_[session_id] = std::move(meta);
}

bool ContentJobDeliveryService::has_active_content_job(const std::string& except_job_id) const {
  std::lock_guard lock(mu_);
  for (const auto& [job_id, sid] : session_by_job_) {
    (void)sid;
    if (!except_job_id.empty() && job_id == except_job_id) continue;
    if (delivered_.count(job_id) || cancelled_.count(job_id)) continue;
    return true;
  }
  return false;
}

std::optional<ContentJobDeliveryService::ReloadMeta>
ContentJobDeliveryService::consume_reload_after_job(const std::string& session_id,
                                                      const std::string& job_id) {
  std::lock_guard lock(mu_);
  if (!job_id.empty()) {
    const auto jit = reload_by_job_.find(job_id);
    if (jit != reload_by_job_.end()) {
      ReloadMeta out = jit->second;
      reload_by_job_.erase(jit);
      if (!session_id.empty()) reload_after_job_.erase(session_id);
      return out;
    }
  }
  if (session_id.empty()) return std::nullopt;
  const auto it = reload_after_job_.find(session_id);
  if (it == reload_after_job_.end()) return std::nullopt;
  ReloadMeta out = it->second;
  reload_after_job_.erase(it);
  return out;
}

void ContentJobDeliveryService::release_chat_model_for_content_studio(
    const std::string& model_id) {
  if (engine_) {
    try {
      engine_->ensure_started();
      json body = json::object();
      if (!model_id.empty()) body["modelId"] = model_id;
      engine_->command("model.unload", body, 120000);
      publish_runtime_model_status("content_studio_unload");
    } catch (...) {
    }
  }
}

bool ContentJobDeliveryService::reload_chat_model_after_job(const std::string& model_id,
                                                          bool force,
                                                          const std::string& except_job_id) {
  (void)force;
  if (has_active_content_job(except_job_id)) {
    cs_log("skip chat model reload — another Content Studio job is still active", "warn");
    return false;
  }

  std::string id = model_id;
  if (id.empty() && cs_settings_) {
    id = cs_settings_->load_generation().value("omegaModelId", "");
  }
  if (id.empty() && config_) {
    id = config_->load().value("defaultModel", "");
  }
  if (id.empty() || id.rfind("remote:", 0) == 0) {
    cs_log("skip chat model reload — no local model id to load", "warn",
           json{{"model_id", model_id}});
    return false;
  }

  if (!chat_model_reloader_) {
    cs_log("skip chat model reload — runtime reloader not wired", "error", json{{"model_id", id}});
    return false;
  }
  schedule_chat_model_reload(id, except_job_id);
  return true;
}

void ContentJobDeliveryService::schedule_chat_model_reload(const std::string& model_id,
                                                           const std::string& job_id) {
  if (!chat_model_reloader_) return;
  cs_log("queue chat model reload after Content Studio job", "info",
         json{{"model_id", model_id}, {"job_id", job_id}});
  chat_model_reloader_(model_id, job_id);
}

void ContentJobDeliveryService::deliver_resume_note(EventBus& events,
                                                    const std::string& session_id, bool failed,
                                                    const ReloadMeta& meta, bool video_ready,
                                                    const std::string& error_hint,
                                                    bool model_reloaded, bool direct_t2v) {
  if (!sessions_ || session_id.empty()) return;

  const std::string product = direct_t2v ? "Text-to-video" : "Content Studio";
  std::string content;
  if (failed) {
    const std::string detail =
        !error_hint.empty() ? error_hint
                            : (!meta.title.empty() ? meta.title : meta.theme);
    const std::string suffix =
        detail.empty() ? "" : " (" + detail.substr(0, std::min<size_t>(detail.size(), 120)) + ")";
    content =
        product + " finished with errors" + suffix +
        (model_reloaded
             ? ". Reloading the chat model now — wait until **Load** shows ready in the chat bar."
             : ". Use **Load** next to the model in the chat bar to reload the chat model, then "
               "say if you want to retry.");
  } else {
    const std::string subject =
        !meta.title.empty() ? meta.title : (!meta.theme.empty() ? meta.theme : "Your video");
    const std::string loaded_again =
        model_reloaded
            ? "I'm reloading the chat model now — wait until **Load** shows ready in the chat bar."
            : "Use **Load** next to the model in the chat bar to reload the chat model.";
    if (video_ready) {
      if (direct_t2v) {
        content = "**" + subject + "** is ready — use **Play in chat** on the card above. " +
                  loaded_again;
      } else {
        content = "**" + subject +
                  "** is ready — use the player on the Content Studio card above (or **Play in "
                  "chat**). " +
                  loaded_again +
                  " Ask me to tweak the script, change voice or visuals, make another version, or "
                  "help publish.";
      }
    } else {
      content = "**" + subject + "** finished in " + product +
                ". Use **Play in chat** on the card above once status shows completed. " +
                loaded_again;
    }
  }

  sessions_->append_message(session_id, "assistant", content, json::object());
  events.publish("omega:session:messageAppended",
                 json{{"sessionId", session_id},
                      {"message", json{{"role", "assistant"}, {"content", content}}}});
}

void ContentJobDeliveryService::release_content_studio_gpu() {
  if (!content_studio_) return;
  try {
    content_studio_->api("POST", "/api/agent/v1/gpu/unload",
                         json{{"reason", "chat_job_finished"}, {"force", true}});
  } catch (...) {
  }
}

void ContentJobDeliveryService::wait_for_job_gpu_release(const std::string& job_id) {
  const bool worker_done = wait_for_job_worker_exit(job_id, 120000);
  cs_log(worker_done ? "pipeline worker exited job=" + job_id
                     : "pipeline worker still running after timeout job=" + job_id,
         worker_done ? "info" : "warn", json{{"job_id", job_id}});
  // The pipeline worker already calls release_generation_gpu() in its finally block.
  // Do NOT invoke gpu-unload via cs_invoke here — it spawns a throwaway Python+CUDA process
  // that can deadlock the GPU driver and freeze omega-runtime while chat reload never runs.
  std::this_thread::sleep_for(std::chrono::milliseconds(3000));
  cs_log("gpu handoff settle complete job=" + job_id, "info", json{{"job_id", job_id}});
}

bool ContentJobDeliveryService::is_chat_model_loaded(const std::string& model_id) const {
  if (!engine_ || model_id.empty()) return false;
  if (!engine_->available()) return false;
  try {
    engine_->ensure_started();
    const json loaded = engine_->command("model.loaded", json::object(), 2000);
    if (!loaded.contains("models") || !loaded["models"].is_array()) return false;
    for (const auto& entry : loaded["models"]) {
      if (!entry.is_string()) continue;
      const std::string id = entry.get<std::string>();
      if (id == model_id || id.find(model_id) != std::string::npos ||
          model_id.find(id) != std::string::npos) {
        return true;
      }
    }
  } catch (...) {
  }
  return false;
}

std::optional<ContentJobDeliveryService::PatchResult>
ContentJobDeliveryService::patch_direct_video_card(const std::string& session_id,
                                                   const std::string& job_id,
                                                   const json& card, const json& video_part) {
  const auto mutator = [&](json& parts, std::string& content) {
    parts = upsert_direct_video_part(parts, card);
    if (video_part.is_object() && !video_part.empty()) {
      json merged = parts.is_array() ? parts : json::array();
      merged.push_back(video_part);
      parts = dedupe_parts(merged);
    }
    (void)content;
  };
  if (auto patched = patch_job_message(session_id, job_id, mutator)) return patched;
  if (!sessions_) return std::nullopt;
  const auto latest = sessions_->patch_latest_assistant_message(session_id, mutator);
  if (!latest) return std::nullopt;
  PatchResult out;
  out.content = latest->content;
  out.parts = latest->parts;
  out.message_index = latest->message_index;
  return out;
}

std::optional<ContentJobDeliveryService::PatchResult>
ContentJobDeliveryService::patch_job_message(
    const std::string& session_id, const std::string& job_id,
    const std::function<void(json& parts, std::string& content)>& mutator) {
  if (!sessions_) return std::nullopt;
  const auto patched = sessions_->patch_assistant_message_with_job(session_id, job_id, mutator);
  if (!patched) return std::nullopt;
  PatchResult out;
  out.content = patched->content;
  out.parts = patched->parts;
  out.message_index = patched->message_index;
  return out;
}

json ContentJobDeliveryService::import_mp4_to_session(const std::string& session_id,
                                                      const std::string& relative_mp4) const {
  if (!projects_ || !profile_) return json();
  std::string rel = relative_mp4;
  for (char& c : rel) {
    if (c == '\\') c = '/';
  }
  while (!rel.empty() && rel.front() == '/') rel.erase(rel.begin());
  fs::path src = fs::path(resolve_content_studio_storage()) / rel;
  if (!fs::exists(src) && fs::exists(rel)) src = fs::path(rel);
  if (!fs::exists(src)) return json();

  projects_->ensure_dir(session_id);
  const fs::path media_dir = fs::path(projects_->open_folder(session_id)) / "media";
  fs::create_directories(media_dir);
  const std::string id = hash_file_prefix(src) + ".mp4";
  const fs::path dest = media_dir / id;
  fs::copy_file(src, dest, fs::copy_options::overwrite_existing);
  return json{{"type", "video"}, {"ref", id}};
}

void ContentJobDeliveryService::publish_assistant_patch(EventBus& events,
                                                        const std::string& session_id,
                                                        const std::string& job_id,
                                                        const PatchResult& patch) {
  events.publish("omega:session:assistantPatch",
                 json{{"sessionId", session_id},
                      {"jobId", job_id},
                      {"content", patch.content},
                      {"parts", patch.parts},
                      {"messageIndex", patch.message_index}});
}

void ContentJobDeliveryService::signal_watcher_stop(const std::string& job_id) {
  std::lock_guard lock(watch_mu_);
  const auto it = watcher_stop_.find(job_id);
  if (it != watcher_stop_.end()) it->second->store(true);
}

void ContentJobDeliveryService::try_finalize_delivery(const std::string& job_id,
                                                      const json& body, EventBus& events) {
  (void)events;
  if (!sessions_ || !events_) return;

  std::string session_id;
  std::string project_id;
  {
    std::lock_guard lock(mu_);
    if (delivered_.count(job_id)) return;
    const auto sit = session_by_job_.find(job_id);
    if (sit == session_by_job_.end()) return;
    session_id = sit->second;
    project_id = project_by_job_.count(job_id) ? project_by_job_[job_id]
                                                : body.value("project_id", body.value("projectId", ""));
    if (session_id.empty() || project_id.empty()) return;
    delivered_.insert(job_id);
  }

  const std::string status = body.value("status", "unknown");
  cs_log("finalize queued job=" + job_id + " status=" + status, "info",
         json{{"job_id", job_id}, {"session_id", session_id}, {"async", true}});

  signal_watcher_stop(job_id);

  schedule_post_cs_chat_reload_if_needed(session_id, job_id, status);

  EventBus* bus = events_;
  std::thread([this, job_id, session_id, project_id, body, bus]() {
    if (!bus) return;
    run_finalize_delivery_worker(job_id, session_id, project_id, body, *bus);
  }).detach();
}

void ContentJobDeliveryService::run_finalize_delivery_worker(const std::string& job_id,
                                                             const std::string& session_id,
                                                             const std::string& project_id,
                                                             json body, EventBus& events) {
  if (!sessions_) return;

  try {
  cs_log("finalize worker start job=" + job_id, "info", json{{"job_id", job_id}});

  const std::string status = body.value("status", "unknown");
  std::string mp4;
  {
    std::lock_guard lock(mu_);
    if (cache_.count(job_id)) mp4 = cache_[job_id].value("mp4Relative", "");
  }
  if (mp4.empty()) {
    if (const auto rel = job_final_mp4_relative(project_id, job_id)) mp4 = *rel;
  }
  const bool has_video = !mp4.empty();
  const bool status_ok = is_success_status(status) || has_video;
  const bool missing_video = !has_video && is_success_status(status);
  const bool failed = !status_ok || missing_video;
  cs_log("finalize job=" + job_id + " status=" + status + (failed ? " (failed)" : " (ok)"),
         failed ? "warn" : "info",
         json{{"job_id", job_id}, {"session_id", session_id}, {"missing_video", missing_video},
              {"mp4", mp4.empty() ? "" : mp4.substr(0, 120)}});
  const std::string display_status = [&]() {
    std::string lower = status;
    for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (lower == "cancelled" || lower == "canceled") return std::string("cancelled");
    if (missing_video) return std::string("failed");
    if (has_video && !failed) return std::string("succeeded");
    return failed ? std::string("failed") : status;
  }();

  const std::string youtube_url =
      body.contains("video") && body["video"].is_object()
          ? body["video"].value("youtube_url", body["video"].value("youtubeUrl", ""))
          : "";

  const int64_t completed_at = now_ms();

  json card = json{{"type", "content_studio"},
                   {"jobId", job_id},
                   {"projectId", project_id},
                   {"status", display_status},
                   {"title", failed ? "Content Studio — render failed" : "Content Studio"},
                   {"completedAt", completed_at}};
  if (!youtube_url.empty()) card["youtubeUrl"] = youtube_url;
  if (missing_video) {
    card["error"] =
        "Render finished but no video file was produced — check Content Studio job logs.";
  }

  PatchResult ui_patch;
  ui_patch.parts = json::array({card});
  ui_patch.content = "";
  ui_patch.message_index = -1;
  publish_assistant_patch(events, session_id, job_id, ui_patch);
  cs_log("finalize worker ui patch published job=" + job_id, "info",
         json{{"job_id", job_id}, {"status", display_status}});

  std::optional<ReloadMeta> reload_meta;
  if (display_status != "cancelled") {
    reload_meta = consume_reload_after_job(session_id, job_id);
  }

  bool session_had_chat_unload = false;
  {
    std::lock_guard lock(mu_);
    session_had_chat_unload = sessions_chat_unloaded_.count(session_id) > 0;
  }

  bool model_reloaded = false;
  bool should_reload_model = false;
  std::string reload_model_id;
  if (reload_meta) {
    reload_model_id = reload_meta->model_id;
    should_reload_model = reload_meta->unloaded_chat_model;
  }
  if (reload_model_id.empty() && cs_settings_) {
    reload_model_id = cs_settings_->load_generation().value("omegaModelId", "");
  }
  if (reload_model_id.empty() && config_) {
    reload_model_id = config_->load().value("defaultModel", "");
  }
  if (!should_reload_model &&
      (session_had_chat_unload || (reload_meta && reload_meta->unloaded_chat_model))) {
    should_reload_model = true;
    cs_log("finalize max_performance — will reload chat model", "info",
           json{{"job_id", job_id},
                {"session_id", session_id},
                {"model_id", reload_model_id},
                {"had_reload_meta", reload_meta.has_value()},
                {"session_unload_flag", session_had_chat_unload}});
  } else if (!should_reload_model && !reload_meta && !reload_model_id.empty()) {
    cs_log("finalize without reload meta — will reload chat model", "info",
           json{{"job_id", job_id}, {"model_id", reload_model_id}});
    should_reload_model = true;
  }
  if (should_reload_model && !reload_model_id.empty()) {
    model_reloaded = true;
  } else if (reload_meta && !reload_meta->unloaded_chat_model) {
    cs_log("finalize keep chat model loaded job=" + job_id, "info", json{{"job_id", job_id}});
  }

  if (should_reload_model && !reload_model_id.empty()) {
    std::lock_guard lock(mu_);
    sessions_chat_unloaded_.erase(session_id);
  }

  drop_watcher(job_id);

  bool reload_already_scheduled = false;
  {
    std::lock_guard lock(mu_);
    reload_already_scheduled = reload_scheduled_jobs_.count(job_id) > 0;
  }
  if (!reload_already_scheduled && should_reload_model && !reload_model_id.empty() &&
      display_status != "cancelled") {
    {
      std::lock_guard lock(mu_);
      reload_scheduled_jobs_.insert(job_id);
    }
    schedule_chat_model_reload_async(reload_model_id, job_id);
  } else if (!reload_already_scheduled && should_reload_model && display_status != "cancelled") {
    cs_log("finalize skip reload — no model id configured job=" + job_id, "error",
           json{{"job_id", job_id}, {"session_id", session_id}});
  }

  const bool failed_copy = failed;
  const std::string err_hint =
      failed ? body.value("error", body.value("detail", "")) : "";
  std::optional<ReloadMeta> reload_copy = reload_meta;
  json card_copy = card;
  const std::string mp4_copy = mp4;
  EventBus* bus = &events;
  std::thread([this, job_id, session_id, card_copy, mp4_copy, failed_copy, err_hint, reload_copy,
               model_reloaded, bus]() {
    json video_part = json();
    if (!failed_copy && !mp4_copy.empty()) {
      video_part = import_mp4_to_session(session_id, mp4_copy);
      cs_log("finalize worker import ok job=" + job_id, "info",
             json{{"job_id", job_id}, {"has_video_part", video_part.is_object()}});
    }
    if (video_part.is_object() && video_part.contains("ref")) {
      json card_with_video = card_copy;
      card_with_video["videoRef"] = video_part["ref"];
      PatchResult patch;
      patch.parts = dedupe_parts(json::array({card_with_video, video_part}));
      patch.content = "";
      patch.message_index = -1;
      if (bus) publish_assistant_patch(*bus, session_id, job_id, patch);
    }
    const auto patch = patch_job_message(session_id, job_id, [&](json& parts, std::string& content) {
      json merged_card = card_copy;
      if (video_part.is_object() && video_part.contains("ref")) {
        merged_card["videoRef"] = video_part["ref"];
      }
      parts = upsert_content_studio_part(parts, merged_card);
      if (video_part.is_object() && !video_part.empty()) {
        json merged = parts.is_array() ? parts : json::array();
        merged.push_back(video_part);
        parts = dedupe_parts(merged);
      }
      (void)content;
    });
    cs_log("finalize worker sqlite patch ok job=" + job_id, "info",
           json{{"job_id", job_id}, {"patched", patch.has_value()}});
    if (reload_copy && bus) {
      deliver_resume_note(*bus, session_id, failed_copy, *reload_copy,
                          video_part.is_object(), err_hint, model_reloaded);
    }
  }).detach();

  {
    std::lock_guard lock(mu_);
    cache_.erase(job_id);
  }

  cs_log("finalize worker done job=" + job_id, "info",
         json{{"job_id", job_id}, {"model_reloaded", model_reloaded}});
  } catch (const std::exception& e) {
    cs_log(std::string("finalize worker crashed: ") + e.what(), "error",
           json{{"job_id", job_id}});
  } catch (...) {
    cs_log("finalize worker crashed job=" + job_id, "error", json{{"job_id", job_id}});
  }
}

void ContentJobDeliveryService::complete_direct_video_job(EventBus& events,
                                                            const std::string& session_id,
                                                            const std::string& job_id,
                                                            bool failed,
                                                            const std::string& error_hint,
                                                            const json& video_part,
                                                            const std::string& title,
                                                            int64_t started_at_ms) {
  const int64_t completed_at = now_ms();
  int64_t elapsed_ms = 0;
  if (started_at_ms > 0 && completed_at >= started_at_ms) {
    elapsed_ms = completed_at - started_at_ms;
  }

  cs_log("direct t2v complete job=" + job_id, failed ? "warn" : "info",
         json{{"session_id", session_id},
              {"failed", failed},
              {"elapsed_ms", elapsed_ms},
              {"error", error_hint.empty() ? json() : json(error_hint)}});

  {
    std::lock_guard lock(mu_);
    delivered_.insert(job_id);
    session_by_job_.erase(job_id);
    project_by_job_.erase(job_id);
  }

  release_content_studio_gpu();

  json card = json{{"type", "direct_video"},
                   {"jobId", job_id},
                   {"status", failed ? "failed" : "succeeded"},
                   {"title", title.empty() ? "Text-to-video" : title}};
  if (started_at_ms > 0) card["startedAt"] = started_at_ms;
  if (completed_at > 0) card["completedAt"] = completed_at;
  if (elapsed_ms > 0) card["elapsedMs"] = elapsed_ms;
  if (failed && !error_hint.empty()) card["error"] = short_error_for_card(error_hint);
  if (video_part.is_object() && video_part.contains("ref")) {
    card["videoRef"] = video_part["ref"];
  }

  std::optional<PatchResult> patch;
  if (sessions_ && !session_id.empty()) {
    patch = patch_direct_video_card(session_id, job_id, card, video_part);
  }
  if (!patch) {
    cs_log("direct t2v card patch missed job=" + job_id, "warn",
           json{{"session_id", session_id}});
  }

  std::optional<ReloadMeta> reload_meta = consume_reload_after_job(session_id, job_id);
  bool model_reloaded = false;
  if (reload_meta) {
    const bool need_reload = reload_meta->unloaded_chat_model ||
                             !is_chat_model_loaded(reload_meta->model_id);
    if (need_reload) {
      model_reloaded = reload_chat_model_after_job(reload_meta->model_id, true, job_id);
    } else {
      publish_runtime_model_status("content_studio_job_keep_agent");
    }
  }

  if (patch) publish_assistant_patch(events, session_id, job_id, *patch);

  if (!failed && video_part.is_object() && media_player_) {
    media_player_->show_preview(json{{"sessionId", session_id}, {"part", video_part}});
  }

  if (reload_meta) {
    ReloadMeta meta = *reload_meta;
    if (meta.title.empty()) meta.title = title;
    deliver_resume_note(events, session_id, failed, meta, video_part.is_object(), error_hint,
                        model_reloaded, true);
  }
}

}  // namespace omega::runtime
