#include "omega/runtime/runtime_context.hpp"

#include "omega/runtime/http_server.hpp"
#include "omega/runtime/json_safe.hpp"
#include "omega/runtime/services/system_info_service.hpp"
#include "omega/runtime/inference/model_load_payload.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/inference/sidecar_model_inventory.hpp"
#include "omega/runtime/inference/sidecar_supervisor.hpp"
#include "omega/runtime/native_routes.hpp"
#include "omega/runtime/paths.hpp"

#include <httplib.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string resolve_catalog_path() {
  const fs::path candidates[] = {
      fs::path("route-catalog.json"),
      fs::path("resources") / "route-catalog.json",
      fs::path("..") / "resources" / "route-catalog.json",
      fs::path("apps") / "runtime" / "resources" / "route-catalog.json"};
  for (const auto& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (!ec && fs::exists(abs)) return abs.string();
  }
  return (fs::path("apps") / "runtime" / "resources" / "route-catalog.json").string();
}

json error_json(int code, const std::string& message, const json& extra = json::object()) {
  json out{{"error", message}, {"code", code}};
  for (auto it = extra.begin(); it != extra.end(); ++it) out[it.key()] = it.value();
  return out;
}

}  // namespace

RuntimeContext::RuntimeContext(ServerOptions options)
    : options_(std::move(options)),
      database_(options_.omega_home.empty() ? omega_home() : options_.omega_home),
      sessions_(database_),
      memory_(database_),
      rag_(database_, engine_, config_),
      workflows_(options_.omega_home.empty() ? omega_home() : options_.omega_home),
      profile_(options_.omega_home.empty() ? omega_home() : options_.omega_home),
      profile_store_(profile_),
      providers_(profile_),
      input_pipelines_(config_),
      mcp_(profile_),
      gateway_store_(profile_),
      project_store_(profile_),
      finetune_store_(profile_),
      content_studio_settings_(profile_),
      finetune_runner_(finetune_store_),
      finetune_datasets_(profile_),
      model_config_(),
      model_meta_(config_, model_config_, engine_),
      hf_client_(config_),
      events_(),
      debug_store_(events_),
      inference_(engine_, providers_),
      terminal_store_(events_),
      integrations_(profile_),
      usage_(profile_),
      self_improve_(profile_, config_, sessions_, memory_, inference_),
      chat_attachments_(config_, project_store_),
      github_client_(integrations_),
      jira_client_(integrations_),
      media_player_(events_),
      updater_(events_),
      office_viz_(profile_),
      model_download_(config_, hf_client_, events_),
      model_quantize_(config_, events_),
      model_load_progress_(events_),
      sidecar_(),
      router_models_(),
      desktop_aux_(),
      mcp_clients_(mcp_, events_),
      skills_(profile_),
      soul_(profile_),
      cron_(profile_),
      kanban_(profile_),
      tools_(config_, profile_, memory_, rag_, skills_, mcp_clients_, plugins_),
      streams_(),
      agent_(engine_, memory_, tools_, streams_),
      workforce_store_(profile_, config_, kanban_, github_client_, jira_client_, events_),
      workforce_(workforce_store_, config_, agent_, inference_, self_improve_, sessions_, events_),
      workflow_runner_(inference_, tools_, agent_, events_),
      chat_(config_, engine_, sessions_, tools_, streams_, memory_, soul_, events_, inference_,
            input_pipelines_, project_store_, usage_),
      gateway_(gateway_store_, chat_, config_, events_),
      cron_scheduler_(cron_, chat_, memory_),
      catalog_path_(resolve_catalog_path()) {
  if (!catalog_.load_from_file(catalog_path_)) {
    std::cerr << "[omega-runtime] warning: route catalog missing at " << catalog_path_ << '\n';
  }
  content_studio_.attach_settings(&content_studio_settings_);
  content_studio_.attach_python(&python_);
  content_studio_.attach_debug(&debug_store_);
  content_job_delivery_.attach(&sessions_, &project_store_, &profile_, &content_studio_, &engine_,
                               &events_, &config_, &content_studio_settings_, &media_player_);
  content_job_delivery_.attach_debug(&debug_store_);
  content_job_delivery_.set_runtime_status_publisher([this](const std::string& reason) {
    publish_runtime_model_status(reason, json::object(), false);
  });
  content_job_delivery_.set_chat_model_reloader([this](const std::string& model_id,
                                                         const std::string& job_id) {
    reload_chat_model_after_content_studio(model_id, job_id);
  });
  content_orchestrator_.attach(&content_studio_, &content_job_delivery_, &content_studio_settings_,
                               &config_, &engine_, &sessions_, &project_store_, &events_,
                               &pipeline_activity_);
  content_orchestrator_.attach_debug(&debug_store_);
  tools_.attach_content_services(&content_studio_, &content_job_delivery_, &sessions_, &events_);
  tools_.attach_content_orchestrator(&content_orchestrator_);
  tools_.attach_debug(&debug_store_);
  agent_desktop_.attach(&config_, &engine_, &media_player_, &desktop_aux_, &events_, &tools_);
  agent_platform_.attach(&config_, &engine_, &events_, &sessions_, &plugins_, &skills_, &memory_,
                         &finetune_store_, &finetune_runner_, &finetune_datasets_, &workforce_,
                         &model_meta_, &project_store_, &media_player_, &content_job_delivery_,
                         &content_orchestrator_, &content_studio_, &usage_);
  tools_.attach_agent_desktop_tools(&agent_desktop_);
  tools_.attach_agent_platform_tools(&agent_platform_);
  tools_.attach_project_store(&project_store_);
  tools_.approvals().set_event_sink([this](const std::string& channel, const json& payload) {
    events_.publish(channel, payload);
  });

  engine_.set_event_handler([this](const std::string& event, const json& payload) {
    if (event == "ModelLoadProgress") {
      const std::string model_id = payload.value("modelId", "");
      const int pct = payload.value("percent", 0);
      const std::string msg = payload.value("message", "");
      if (!model_id.empty() && pct > 0) {
        model_load_progress_.emit_percent(model_id, pct, msg);
      }
    }
    apply_engine_event_to_model_cache(event, payload);
    json extra{{"engineEvent", event}};
    if (payload.contains("modelId")) extra["modelId"] = payload["modelId"];
    if (event != "token" && event.find("token") == std::string::npos) {
      debug_store_.log("engine", event, "info", extra);
    }
    // Never call engine_.command from the stdout reader thread — use cached status only.
    publish_runtime_model_status("engine_event", extra, false);
  });

  engine_.set_failure_handler([this](const std::string& reason) {
    handle_engine_failure(reason);
  });
}

void RuntimeContext::apply_engine_event_to_model_cache(const std::string& event, const json& payload) {
  const std::string model_id = payload.value("modelId", "");
  std::lock_guard lock(model_status_mu_);
  if (event == "ModelLoaded" && !model_id.empty()) {
    cached_model_status_["activeModel"] = model_id;
    cached_model_status_["nativeLoaded"] = model_id;
    json models = cached_model_status_.value("loadedModels", json::array());
    if (!models.is_array()) models = json::array();
    bool found = false;
    for (const auto& m : models) {
      if (m.is_string() && m.get<std::string>() == model_id) found = true;
    }
    if (!found) models.push_back(model_id);
    cached_model_status_["loadedModels"] = models;
    cached_model_status_["state"] = "ready";
    return;
  }
  if (event == "ModelUnloaded") {
    if (!model_id.empty()) {
      json models = cached_model_status_.value("loadedModels", json::array());
      if (models.is_array()) {
        json next = json::array();
        for (const auto& m : models) {
          if (m.is_string() && m.get<std::string>() != model_id) next.push_back(m);
        }
        cached_model_status_["loadedModels"] = next;
      }
      if (cached_model_status_.value("activeModel", "") == model_id) {
        cached_model_status_["activeModel"] = "";
        cached_model_status_["nativeLoaded"] = "";
      }
    } else {
      cached_model_status_["loadedModels"] = json::array();
      cached_model_status_["activeModel"] = "";
      cached_model_status_["nativeLoaded"] = "";
    }
    cached_model_status_["state"] = "ready";
  }
}

void RuntimeContext::handle_engine_failure(const std::string& reason) {
  json payload;
  {
    std::lock_guard lock(model_status_mu_);
    if (cached_model_status_.value("state", "") == "loading") {
      cached_model_status_["state"] = "error";
      cached_model_status_["engine_error"] = reason;
      cached_model_status_.erase("loadingModel");
      payload = cached_model_status_;
    } else {
      cached_model_status_["loadedModels"] = json::array();
      cached_model_status_["activeModel"] = "";
      cached_model_status_["nativeLoaded"] = "";
      cached_model_status_["state"] = "error";
      cached_model_status_["engine_error"] = reason;
      payload = cached_model_status_;
    }
  }
  payload["reason"] = "engine_failure";
  events_.publish("omega:runtime:status-changed", payload);
}

json RuntimeContext::runtime_model_status_snapshot() {
  json payload;
  bool skip_engine_query = false;
  {
    std::lock_guard lock(model_status_mu_);
    payload = cached_model_status_;
    const std::string state = payload.value("state", "");
    skip_engine_query =
        state == "loading" || state == "error" || !engine_.available();
  }
  if (!payload.contains("state")) payload["state"] = "ready";
  if (!payload.contains("activeModel")) payload["activeModel"] = "";
  if (!payload.contains("loadedModels")) payload["loadedModels"] = json::array();
  if (!payload.contains("nativeLoaded")) payload["nativeLoaded"] = "";
  payload["inference"] = "engine";
  payload["engine_running"] = engine_.available();
  if (skip_engine_query) {
    payload["runtimeLoadedStems"] = payload.value("loadedModels", json::array());
    return payload;
  }
  try {
    if (engine_.ensure_started()) {
      const json loaded = engine_.command("model.loaded", json::object(), 30000);
      if (loaded.contains("models") && loaded["models"].is_array()) {
        payload["loadedModels"] = loaded["models"];
      }
      if (loaded.contains("activeModelId")) {
        const std::string active = loaded["activeModelId"].get<std::string>();
        payload["activeModel"] = active;
        payload["nativeLoaded"] = active;
      }
      const std::string sidecar_id = SidecarSupervisor::instance().loaded_model_id();
      if (!sidecar_id.empty()) {
        payload["activeModel"] = sidecar_id;
        payload["sidecarLoaded"] = sidecar_id;
        json models = payload.value("loadedModels", json::array());
        if (!models.is_array()) models = json::array();
        bool found = false;
        for (const auto& m : models) {
          if (m.is_string() && m.get<std::string>() == sidecar_id) found = true;
        }
        if (!found) models.push_back(sidecar_id);
        payload["loadedModels"] = models;
      }
      payload["state"] = "ready";
      payload.erase("engine_error");
      std::lock_guard lock(model_status_mu_);
      cached_model_status_ = payload;
    }
  } catch (const std::exception& e) {
    if (payload.value("state", "") == "loading") {
      payload["engine_error"] = e.what();
      payload["runtimeLoadedStems"] = payload.value("loadedModels", json::array());
      payload["engine_running"] = engine_.available();
      return payload;
    }
    handle_engine_failure(e.what());
    payload["state"] = "error";
    payload["engine_error"] = e.what();
    payload["activeModel"] = "";
    payload["nativeLoaded"] = "";
    payload["loadedModels"] = json::array();
  }
  payload["runtimeLoadedStems"] = payload.value("loadedModels", json::array());
  payload["engine_running"] = engine_.available();
  return payload;
}

json RuntimeContext::load_model_sync(const std::string& model_id, const json& body_in) {
  std::lock_guard lock(engine_load_mu_);
  json body = body_in.is_object() ? body_in : json::object();
  if (!body.contains("modelId") && !model_id.empty()) body["modelId"] = model_id;
  const std::string resolved_id = body.value("modelId", model_id);
  if (resolved_id.empty()) throw std::runtime_error("modelId required");
  const bool after_cs = body.value("afterContentStudio", false);

  {
    std::lock_guard lock(model_status_mu_);
    cached_model_status_["state"] = "loading";
    cached_model_status_["loadingModel"] = resolved_id;
    cached_model_status_.erase("engine_error");
  }
  model_load_progress_.emit(resolved_id, "start", "Loading model…");
  append_load_diagnostic("model.load begin modelId=" + resolved_id);

  const json cfg = config_.load();
  const std::string models_root = cfg.value("modelsDir", models_dir());
  const std::string sidecar_dir = sidecar_model_directory(models_root, resolved_id);
  if (!sidecar_dir.empty()) {
    model_load_progress_.emit(resolved_id, "prepare", "Starting sidecar…");
    const std::string fmt = detect_sidecar_format(sidecar_dir);
    if (fmt.empty()) throw std::runtime_error("Could not detect sidecar format for " + resolved_id);
    const json settings = resolve_model_settings(config_, resolved_id);
    const int max_seq = settings.value("contextSize", 8192);
    try {
      engine_.command("model.unload", json::object(), 120000);
    } catch (...) {
    }
    SidecarSupervisor::instance().unload_model();
    model_load_progress_.emit(resolved_id, "weights", "Loading sidecar weights…");
    append_load_diagnostic("model.load dispatch to sidecar format=" + fmt + " path=" + sidecar_dir);
    const json sidecar_result =
        SidecarSupervisor::instance().load_model(resolved_id, sidecar_dir, fmt, max_seq);
    model_load_progress_.emit(resolved_id, "ready", "Ready");
    {
      std::lock_guard lock(model_status_mu_);
      cached_model_status_["state"] = "ready";
      cached_model_status_["activeModel"] = resolved_id;
      cached_model_status_["sidecarLoaded"] = resolved_id;
      cached_model_status_["nativeLoaded"] = "";
      json models = cached_model_status_.value("loadedModels", json::array());
      if (!models.is_array()) models = json::array();
      bool found = false;
      for (const auto& m : models) {
        if (m.is_string() && m.get<std::string>() == resolved_id) found = true;
      }
      if (!found) models.push_back(resolved_id);
      cached_model_status_["loadedModels"] = models;
      cached_model_status_.erase("loadingModel");
    }
    publish_runtime_model_status("model_load", json{{"modelId", resolved_id}, {"backend", fmt}});
    return json{{"modelId", resolved_id},
                {"backend", fmt},
                {"path", sidecar_dir},
                {"sidecar", sidecar_result}};
  }

  model_load_progress_.emit(resolved_id, "prepare", "Preparing engine…");
  if (!engine_.ensure_started()) {
    const std::string err =
        engine_.last_error().empty() ? "omega-engine unavailable" : engine_.last_error();
    append_load_diagnostic("ensure_started failed: " + err);
    throw std::runtime_error(err);
  }
  if (after_cs) {
    append_load_diagnostic("post-Content-Studio load: engine started, probing health");
    debug_store_.log("content-studio", "post-CS load engine started", "info",
                     json{{"model_id", resolved_id}});
  }
  auto probe_engine_health = [this, after_cs]() -> json {
    const int timeout_ms = after_cs ? 20000 : 30000;
    return engine_.command("health", json::object(), timeout_ms);
  };
  try {
    json health = probe_engine_health();
    append_load_diagnostic("engine health infer_available=" +
                           std::string(health.value("infer_available", false) ? "true" : "false") +
                           " compiled_backends=" +
                           health.value("compiled_backends", std::string("unknown")));
    if (!health.value("infer_available", false)) {
      const std::string backends = health.value("compiled_backends", std::string("unknown"));
      throw std::runtime_error("libomega_infer unavailable in packaged engine (compiled_backends=" +
                               backends + ")");
    }
  } catch (const std::exception& health_err) {
    if (!after_cs) {
      append_load_diagnostic(std::string("health failed: ") + health_err.what());
      throw;
    }
    append_load_diagnostic(std::string("post-CS health failed, restarting engine: ") +
                           health_err.what());
    engine_.stop();
    std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    if (!engine_.ensure_started()) {
      append_load_diagnostic("post-CS engine restart failed: " + engine_.last_error());
      throw std::runtime_error(engine_.last_error().empty() ? health_err.what()
                                                            : engine_.last_error());
    }
    try {
      const json health = probe_engine_health();
      append_load_diagnostic("post-CS engine health infer_available=" +
                             std::string(health.value("infer_available", false) ? "true" : "false"));
      if (!health.value("infer_available", false)) {
        throw std::runtime_error("libomega_infer unavailable after engine restart");
      }
    } catch (const std::exception& retry_err) {
      append_load_diagnostic(std::string("post-CS health retry failed: ") + retry_err.what());
      throw;
    }
  }

  model_load_progress_.emit(resolved_id, "weights", "Loading weights…");
  append_load_diagnostic("model.load dispatch to engine (internal GPU/CPU/context fallback)");
  json load_body = build_model_load_payload(config_, resolved_id, body);
  const std::vector<int> gpu_tiers = model_load_gpu_tiers(config_, resolved_id, load_body);
  json data = json::object();
  std::string last_err;
  for (size_t tier_idx = 0; tier_idx < gpu_tiers.size(); ++tier_idx) {
    json attempt_body = load_body;
    apply_gpu_layers_to_load_body(attempt_body, gpu_tiers[tier_idx]);
    try {
      data = engine_.command("model.load", attempt_body, 600000);
      last_err.clear();
      break;
    } catch (const std::exception& load_err) {
      last_err = load_err.what();
      append_load_diagnostic(std::string("model.load engine error: ") + last_err);
      if (model_load_error_is_fatal(last_err)) throw;
      if (model_load_engine_died(last_err, engine_.available())) {
        append_load_diagnostic("engine died during load — restarting once");
        engine_.stop();
        if (!engine_.ensure_started()) {
          throw std::runtime_error(engine_.last_error().empty() ? last_err : engine_.last_error());
        }
        data = engine_.command("model.load", attempt_body, 600000);
        last_err.clear();
        break;
      }
      const bool can_retry = model_load_error_may_retry_lower_gpu(last_err) &&
                             tier_idx + 1 < gpu_tiers.size();
      if (!can_retry) throw;
      append_load_diagnostic("model.load VRAM pressure at gpu_layers=" +
                             std::to_string(gpu_tiers[tier_idx]) + " — retrying with fewer layers");
      try {
        engine_.command("model.unload", json::object(), 120000);
      } catch (...) {
      }
    }
  }
  if (!last_err.empty() && data.empty()) throw std::runtime_error(last_err);

  model_load_progress_.emit(resolved_id, "ready", "Ready");
  SidecarSupervisor::instance().unload_model();
  {
    std::lock_guard lock(model_status_mu_);
    cached_model_status_["state"] = "ready";
    cached_model_status_["activeModel"] = resolved_id;
    cached_model_status_["nativeLoaded"] = resolved_id;
    json models = cached_model_status_.value("loadedModels", json::array());
    if (!models.is_array()) models = json::array();
    bool found = false;
    for (const auto& m : models) {
      if (m.is_string() && m.get<std::string>() == resolved_id) found = true;
    }
    if (!found) models.push_back(resolved_id);
    cached_model_status_["loadedModels"] = models;
    cached_model_status_.erase("sidecarLoaded");
    cached_model_status_.erase("loadingModel");
    cached_model_status_.erase("engine_error");
  }
  publish_runtime_model_status("model_load", json{{"modelId", resolved_id}});
  return data;
}

void RuntimeContext::reload_chat_model_after_content_studio(const std::string& model_id,
                                                            const std::string& job_id) {
  if (model_id.empty() || model_id.rfind("remote:", 0) == 0) return;
  debug_store_.log("content-studio", "reloading chat model after Content Studio job", "info",
                   json{{"model_id", model_id}, {"job_id", job_id}});
  publish_runtime_model_status("content_studio_job_reload_pending",
                               json{{"modelId", model_id}, {"jobId", job_id}}, false);
  auto attempt_load = [this, model_id]() {
    load_model_sync(model_id, json{{"forceLoad", true}, {"afterContentStudio", true}});
  };
  try {
    try {
      attempt_load();
    } catch (const std::exception& first_err) {
      append_load_diagnostic(std::string("post-CS load retry after engine restart: ") +
                             first_err.what());
      {
        std::lock_guard lock(engine_load_mu_);
        engine_.stop();
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2000));
      attempt_load();
    }
    publish_runtime_model_status("content_studio_job_reload",
                                 json{{"modelId", model_id}, {"jobId", job_id}});
    debug_store_.log("content-studio", "chat model reloaded after Content Studio job", "info",
                     json{{"model_id", model_id}, {"job_id", job_id}});
  } catch (const std::exception& e) {
    const std::string log_hint = " See " + resolve_load_diagnostic_log() + " and " +
                                 resolve_engine_stderr_log() + ".";
    {
      std::lock_guard lock(model_status_mu_);
      cached_model_status_["state"] = "error";
      cached_model_status_["engine_error"] = std::string(e.what()) + log_hint;
      cached_model_status_.erase("loadingModel");
    }
    publish_runtime_model_status("content_studio_job_reload_failed",
                                 json{{"error", e.what()},
                                      {"modelId", model_id},
                                      {"jobId", job_id},
                                      {"log", resolve_load_diagnostic_log()},
                                      {"engineLog", resolve_engine_stderr_log()}});
    debug_store_.log("content-studio",
                     std::string("chat model reload failed after Content Studio job: ") + e.what(),
                     "error", json{{"model_id", model_id}, {"job_id", job_id}});
    throw;
  }
}

void RuntimeContext::publish_runtime_model_status(const std::string& reason, const json& extra,
                                                  bool query_engine) {
  if (reason == "content_studio_unload") {
    std::lock_guard lock(model_status_mu_);
    cached_model_status_["state"] = "idle";
    cached_model_status_["activeModel"] = "";
    cached_model_status_["nativeLoaded"] = "";
    cached_model_status_["loadedModels"] = json::array();
    cached_model_status_.erase("sidecarLoaded");
    cached_model_status_.erase("loadingModel");
    cached_model_status_.erase("engine_error");
  }
  json payload =
      query_engine ? runtime_model_status_snapshot()
                   : [&]() {
                       std::lock_guard lock(model_status_mu_);
                       return cached_model_status_;
                     }();
  payload["reason"] = reason;
  for (auto it = extra.begin(); it != extra.end(); ++it) payload[it.key()] = it.value();
  events_.publish("omega:runtime:status-changed", payload);
}

RuntimeContext::~RuntimeContext() { stop_background_services(); }

void RuntimeContext::try_bootstrap_content_studio(const char* reason) {
  try {
    const json st = content_studio_.status();
    if (!st.value("available", false)) return;
    if (!st.value("venvReady", false)) return;
    if (!st.value("apiPackagesReady", false)) return;
    if (st.value("ready", false)) return;
    if (python_.setup_running()) return;
    content_studio_.ensure_ready();
    events_.publish("omega:content-studio:changed", json::object());
    debug_store_.log("content-studio",
                     std::string("folders and database ready (") + reason + ")", "info");
  } catch (const std::exception& e) {
    debug_store_.log("content-studio",
                     std::string("bootstrap skipped (") + reason + "): " + e.what(), "warn");
  }
}

void RuntimeContext::start_background_services() {
  cron_scheduler_.start();
  gateway_.start_all_enabled();
  std::thread([this]() { try_bootstrap_content_studio("startup"); }).detach();
  std::thread([this]() {
    append_load_diagnostic("runtime startup engine probe");
    append_load_diagnostic("runtime_dir=" + runtime_executable_dir());
    append_load_diagnostic("engine_bin=" + resolve_engine_binary());
    try {
      if (!engine_.ensure_started()) {
        append_load_diagnostic("startup probe: ensure_started failed: " + engine_.last_error());
        return;
      }
      const json health = engine_.command("health", json::object(), 30000);
      append_load_diagnostic(
          "startup probe health infer_available=" +
          std::string(health.value("infer_available", false) ? "true" : "false") +
          " backends=" + health.value("compiled_backends", std::string("unknown")));
    } catch (const std::exception& e) {
      append_load_diagnostic(std::string("startup probe failed: ") + e.what());
    }
  }).detach();
  for (const auto& row : mcp_.list()) {
    if (!row.value("enabled", false)) continue;
    const std::string id = row.value("id", "");
    if (id.empty()) continue;
    std::thread([this, id]() {
      try {
        mcp_clients_.start(id);
      } catch (...) {
      }
    }).detach();
  }
}

void RuntimeContext::stop_background_services() {
  gateway_.stop_all();
  cron_scheduler_.stop();
}

json RuntimeContext::system_info_snapshot() {
  return gather_system_info(SystemInfoInputs{
      [this]() { return runtime_info(); },
      [this]() { return runtime_model_status_snapshot(); },
      engine_,
      python_,
      content_studio_,
      sidecar_,
      updater_,
      router_models_,
      model_load_progress_,
      mcp_clients_,
      gateway_,
      office_viz_,
  });
}

json RuntimeContext::runtime_info() const {
  const auto summary = catalog_.summary();
  return json{
      {"name", "omega-runtime"},
      {"version", "2.0.0"},
      {"build_tag", "cs-reload-early-20250618"},
      {"omega_home", omega_home()},
      {"transport", "http"},
      {"default_port", options_.port},
      {"route_catalog", catalog_path_},
      {"route_summary", summary},
      {"engine_available", engine_.available()},
      {"engine_error", engine_.last_error()},
      {"capabilities",
       json{{"health", true},
            {"config", true},
            {"models", true},
            {"engine_command", true},
            {"sessions", true},
            {"memory", true},
            {"rag", true},
            {"workflows", true},
            {"workflows_run", true},
            {"skills", true},
            {"profiles", true},
            {"soul", true},
            {"cron", true},
            {"cron_scheduler", true},
            {"kanban", true},
            {"tools", true},
            {"chat", true},
            {"agent", true},
            {"orchestrator", true},
            {"events", true},
            {"providers", true},
            {"input_pipelines", true},
            {"inference_router", true},
            {"plugins", true},
            {"mcp", true},
            {"ollama", true},
            {"gateway", true},
            {"python_unified", true},
            {"content_studio", true},
            {"finetune", true},
            {"projects", true}}}};
}

void RuntimeContext::register_routes(httplib::Server& svr) {
  svr.set_pre_routing_handler([this](const httplib::Request& req, httplib::Response& res) {
    if (req.method == "GET" && req.path == "/healthz") {
      res.set_content(R"({"ok":true})", "application/json");
      return httplib::Server::HandlerResponse::Handled;
    }
    if (req.method == "GET" && req.path == "/v1/runtime/info") {
      res.set_content(runtime_info().dump(), "application/json");
      return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });

  register_native_routes(svr, NativeRouteDeps{config_, sessions_, memory_, rag_, workflows_, profile_,
                                              profile_store_, providers_, input_pipelines_, plugins_,
                                              mcp_, mcp_clients_, gateway_, project_store_,
                                              pipeline_activity_, debug_store_, finetune_store_,
                                              python_, content_studio_, content_orchestrator_,
                                              content_studio_settings_, content_job_delivery_, model_config_, finetune_runner_, finetune_datasets_,
                                              model_meta_, hf_client_, inference_, terminal_store_,
                                              integrations_, usage_, self_improve_, chat_attachments_,
                                              workforce_store_, workforce_, github_client_, jira_client_,
                                              media_player_, updater_, office_viz_, model_download_,
                                              model_quantize_, model_load_progress_, sidecar_,
                                              router_models_, desktop_aux_, engine_,
                                              skills_, soul_, cron_, kanban_, tools_, chat_, agent_,
                                              events_, workflow_runner_});

  svr.Get("/healthz", [](const httplib::Request&, httplib::Response& res) {
    res.set_content(R"({"ok":true})", "application/json");
  });

  debug_store_.log("runtime", "HTTP server ready", "info");

  svr.Get("/v1/runtime/info", [this](const httplib::Request&, httplib::Response& res) {
    res.set_content(runtime_info().dump(), "application/json");
  });

  svr.Get("/v1/runtime/routes", [this](const httplib::Request&, httplib::Response& res) {
    res.set_content(catalog_.to_json().dump(), "application/json");
  });

  svr.Get("/v1/config", [this](const httplib::Request&, httplib::Response& res) {
    try {
      res.set_content(json{{"config", config_.load()}}.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 500;
      res.set_content(error_json(500, e.what()).dump(), "application/json");
    }
  });

  svr.Patch("/v1/config",
            [this](const httplib::Request& req, httplib::Response& res) {
              try {
                json body = req.body.empty() ? json::object() : json::parse(req.body);
                const json patch = body.contains("patch") ? body["patch"] : body;
                const json cfg = config_.save_patch(patch);
                content_studio_settings_.sync_generation_from_app_config(cfg);
                res.set_content(json{{"config", cfg}}.dump(), "application/json");
                events_.publish("omega:config:changed", cfg);
              } catch (const std::exception& e) {
                res.status = 400;
                res.set_content(error_json(400, e.what()).dump(), "application/json");
              }
            });

  svr.Get("/v1/runtime/status", [this](const httplib::Request&, httplib::Response& res) {
    // Never block on engine IPC here — UI polls this during model load / post-Content Studio handoff.
    json payload;
    {
      std::lock_guard lock(model_status_mu_);
      payload = cached_model_status_;
    }
    if (!payload.contains("state")) payload["state"] = "ready";
    if (!payload.contains("activeModel")) payload["activeModel"] = "";
    if (!payload.contains("loadedModels")) payload["loadedModels"] = json::array();
    if (!payload.contains("nativeLoaded")) payload["nativeLoaded"] = "";
    payload["inference"] = "engine";
    payload["engine_running"] = engine_.available();
    payload["runtimeLoadedStems"] = payload.value("loadedModels", json::array());
    res.set_content(json_dump_safe(payload), "application/json");
  });

  svr.Get("/v1/system/info", [this](const httplib::Request&, httplib::Response& res) {
    res.set_content(json_dump_safe(system_info_snapshot()), "application/json");
  });

  svr.Get("/v1/models", [this](const httplib::Request&, httplib::Response& res) {
    try {
      json data = engine_.command("model.list", json::object(), 30000);
      if (!data.contains("models") || !data["models"].is_array()) data["models"] = json::array();
      const json cfg = config_.load();
      const std::string root = cfg.value("modelsDir", models_dir());
      const json sidecar_models = scan_sidecar_models(root);
      if (sidecar_models.is_array()) {
        for (const auto& entry : sidecar_models) {
          if (!entry.is_object()) continue;
          const std::string id = entry.value("id", "");
          if (id.empty()) continue;
          bool replaced = false;
          for (auto& m : data["models"]) {
            if (m.is_object() && m.value("id", "") == id) {
              m = entry;
              replaced = true;
              break;
            }
          }
          if (!replaced) data["models"].push_back(entry);
        }
      }
      const json provider_models = providers_.models_for_chat();
      if (provider_models.is_array()) {
        for (const auto& entry : provider_models) {
          if (!entry.is_object()) continue;
          const std::string id = entry.value("id", "");
          if (id.empty()) continue;
          bool replaced = false;
          for (auto& m : data["models"]) {
            if (m.is_object() && m.value("id", "") == id) {
              m = entry;
              replaced = true;
              break;
            }
          }
          if (!replaced) data["models"].push_back(entry);
        }
      }
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Get("/v1/models/loaded", [this](const httplib::Request&, httplib::Response& res) {
    try {
      bool skip = false;
      json cached;
      {
        std::lock_guard lock(model_status_mu_);
        const std::string state = cached_model_status_.value("state", "");
        skip = state == "loading" || state == "idle" || state == "error";
        cached = cached_model_status_;
      }
      if (skip) {
        json payload = json::object();
        const json stems = cached.value("loadedModels", json::array());
        payload["models"] = stems.is_array() ? stems : json::array();
        payload["activeModelId"] = cached.value("activeModel", "");
        if (cached.value("state", "") == "loading") payload["loading"] = true;
        res.set_content(payload.dump(), "application/json");
        return;
      }
      const json data = engine_.command("model.loaded", json::object(), 10000);
      json payload = data;
      const std::string sidecar_id = SidecarSupervisor::instance().loaded_model_id();
      if (!sidecar_id.empty()) {
        payload["activeModelId"] = sidecar_id;
        json models = payload.value("models", json::array());
        if (!models.is_array()) models = json::array();
        bool found = false;
        for (const auto& m : models) {
          if (m.is_string() && m.get<std::string>() == sidecar_id) found = true;
        }
        if (!found) models.push_back(sidecar_id);
        payload["models"] = models;
        payload["sidecarLoaded"] = sidecar_id;
      }
      res.set_content(payload.dump(), "application/json");
    } catch (const std::exception& e) {
      bool loading = false;
      {
        std::lock_guard lock(model_status_mu_);
        loading = cached_model_status_.value("state", "") == "loading";
      }
      if (!loading) handle_engine_failure(e.what());
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Post("/v1/models/load", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = req.body.empty() ? json::object() : json::parse(req.body);
      if (body.is_array() && !body.empty()) body = body[0];
      if (body.is_string()) body = json{{"modelId", body.get<std::string>()}};
      if (body.is_object() && !body.contains("modelId") && body.contains("model")) {
        body["modelId"] = body["model"];
      }
      const std::string model_id = body.is_object() ? body.value("modelId", "") : "";
      const json data = load_model_sync(model_id, body);
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      const std::string log_hint = " See " + resolve_load_diagnostic_log() + " and " +
                                   resolve_engine_stderr_log() + ".";
      append_load_diagnostic(std::string("model.load failed: ") + e.what());
      {
        std::lock_guard lock(model_status_mu_);
        cached_model_status_["state"] = "error";
        cached_model_status_["engine_error"] = std::string(e.what()) + log_hint;
        cached_model_status_.erase("loadingModel");
      }
      publish_runtime_model_status("model_load_failed",
                                   json{{"error", e.what()},
                                        {"log", resolve_load_diagnostic_log()},
                                        {"engineLog", resolve_engine_stderr_log()}});
      res.status = 503;
      res.set_content(error_json(503, e.what() + log_hint).dump(), "application/json");
    }
  });

  svr.Post("/v1/models/unload", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = req.body.empty() ? json::object() : json::parse(req.body);
      if (body.is_array() && !body.empty()) body = body[0];
      if (body.is_string()) body = json{{"modelId", body.get<std::string>()}};
      if (body.is_object() && !body.contains("modelId") && body.contains("model")) {
        body["modelId"] = body["model"];
      }
      const std::string model_id = body.is_object() ? body.value("modelId", "") : "";
      json data = json::object();
      bool did_sidecar = false;
      const std::string sidecar_loaded = SidecarSupervisor::instance().loaded_model_id();
      if (!sidecar_loaded.empty() && (model_id.empty() || sidecar_loaded == model_id)) {
        data = SidecarSupervisor::instance().unload_model();
        did_sidecar = true;
        {
          std::lock_guard lock(model_status_mu_);
          if (cached_model_status_.value("sidecarLoaded", "") == sidecar_loaded) {
            cached_model_status_.erase("sidecarLoaded");
          }
          if (cached_model_status_.value("activeModel", "") == sidecar_loaded) {
            cached_model_status_["activeModel"] = cached_model_status_.value("nativeLoaded", "");
          }
          json models = cached_model_status_.value("loadedModels", json::array());
          if (models.is_array()) {
            json next = json::array();
            for (const auto& m : models) {
              if (m.is_string() && m.get<std::string>() != sidecar_loaded) next.push_back(m);
            }
            cached_model_status_["loadedModels"] = next;
          }
        }
      }
      try {
        const json engine_data = engine_.command("model.unload", body, 120000);
        if (!did_sidecar) data = engine_data;
      } catch (const std::exception& e) {
        if (!did_sidecar) throw;
      }
      publish_runtime_model_status("model_unload",
                                   model_id.empty() ? json::object() : json{{"modelId", model_id}});
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Delete(R"(/v1/models/([A-Za-z0-9._\-/]+))", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      const std::string model_id = req.matches[1];
      const json data = engine_.command("model.delete", json{{"modelId", model_id}}, 120000);
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Post("/v1/generate", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = json::parse(req.body);
      const json data = engine_.command("chat.generate", body, 600000);
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Post("/v1/embed", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = json::parse(req.body);
      const json data = engine_.command("chat.embed", body, 120000);
      res.set_content(data.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Post("/v1/ipc/invoke", [](const httplib::Request&, httplib::Response& res) {
    res.status = 410;
    res.set_content(
        error_json(410, "Electron IPC invoke removed — use native omega-runtime HTTP routes").dump(),
        "application/json");
  });

  svr.Post("/v1/engine/command", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = json::parse(req.body);
      const std::string type = body.value("type", "");
      if (type.empty()) throw std::runtime_error("type is required");
      const json payload = body.contains("payload") ? body["payload"] : json::object();
      const json data = engine_.command(type, payload, 600000);
      res.set_content(json{{"success", true}, {"data", data}}.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  svr.Get("/v1/python/status", [this](const httplib::Request&, httplib::Response& res) {
    res.set_content(python_.status().dump(), "application/json");
  });

  svr.Post("/v1/python/setup", [this](const httplib::Request& req, httplib::Response& res) {
    try {
      json body = req.body.empty() ? json::object() : json::parse(req.body);
      const std::string profile = body.value("profile", "base");
      const bool async_setup = body.value("async", true);
      if (python_.setup_running()) {
        res.set_content(python_.status().dump(), "application/json");
        return;
      }
      const auto bootstrap_after_setup = [this, profile]() {
        if (profile == "content" || profile == "content-media" || profile == "full") {
          try_bootstrap_content_studio("post-python-setup");
        }
      };
      if (async_setup) {
        std::thread([this, profile, bootstrap_after_setup]() {
          try {
            python_.run_setup(profile, events_);
            bootstrap_after_setup();
          } catch (const std::exception& e) {
            try {
              const fs::path log_dir = fs::path(omega_home()) / "content-studio" / "logs";
              fs::create_directories(log_dir);
              std::ofstream log(log_dir / "setup.log", std::ios::app);
              log << "setup failed: " << e.what() << "\n";
            } catch (...) {
            }
          } catch (...) {
          }
        }).detach();
        json started = python_.status();
        started["async"] = true;
        res.set_content(started.dump(), "application/json");
        return;
      }
      json setup_result = python_.run_setup(profile, events_);
      bootstrap_after_setup();
      res.set_content(setup_result.dump(), "application/json");
    } catch (const std::exception& e) {
      res.status = 503;
      res.set_content(error_json(503, e.what()).dump(), "application/json");
    }
  });

  const auto route_not_found = [this](const httplib::Request& req, httplib::Response& res) {
    if (is_native_route(req.method, req.path)) return;
    res.status = 404;
    res.set_content(
        error_json(404, "Route not found", json{{"method", req.method}, {"path", req.path}}).dump(),
        "application/json");
  };

  svr.Post("/v1/.*", route_not_found);
  svr.Patch("/v1/.*", route_not_found);
  svr.Delete("/v1/.*", route_not_found);
  svr.Get("/v1/.*", route_not_found);
}

}  // namespace omega::runtime
