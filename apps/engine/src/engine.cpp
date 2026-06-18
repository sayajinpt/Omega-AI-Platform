#include "omega/engine/engine.hpp"

#include <chrono>
#include <filesystem>
#include <nlohmann/json.hpp>

#include "omega/engine/json_protocol.hpp"
#include "omega/engine/json_safe.hpp"
#include "omega/engine/inference_service.hpp"
#include "omega/engine/media_service.hpp"

#ifdef OMEGA_ENGINE_HAVE_INFER
#include "omega_infer.h"
#endif

namespace fs = std::filesystem;
namespace omega::engine {

namespace {

using json = nlohmann::json;

constexpr const char* k_version = "1.0.0";

CommandResponse ok_json(const Command& cmd, const json& data) {
  return CommandResponse{
      .id = cmd.id, .type = cmd.type, .success = true, .data_json = json_dump_safe(data)};
}

CommandResponse fail(const Command& cmd, const std::string& message) {
  return CommandResponse{.id = cmd.id,
                         .type = cmd.type,
                         .success = false,
                         .data_json = "{}",
                         .error = message};
}

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

json model_to_json(const ModelRecord& m) {
  json meta = json::object();
  if (!m.metadata.architecture.empty()) meta["architecture"] = m.metadata.architecture;
  if (!m.metadata.quantization.empty()) meta["quantization"] = m.metadata.quantization;
  if (m.metadata.context_len > 0) meta["context_len"] = m.metadata.context_len;
  if (m.metadata.param_count > 0) meta["param_count"] = m.metadata.param_count;
  json row;
  row["id"] = m.id;
  row["path"] = m.path;
  row["size_bytes"] = m.size_bytes;
  row["metadata"] = std::move(meta);
  row["nativeSupported"] = InferenceService::infer_available();
  row["format"] = "gguf";
  row["inferenceBackend"] = "native";
  return row;
}

SpeculativeOptions parse_speculative(const json& payload) {
  SpeculativeOptions spec;
  if (!payload.contains("speculative") || !payload["speculative"].is_object()) return spec;
  const auto& s = payload["speculative"];
  if (s.contains("enabled")) spec.enabled = s["enabled"].get<bool>();
  if (s.contains("types") && s["types"].is_array()) {
    for (const auto& t : s["types"]) {
      if (t.is_string()) spec.types.push_back(t.get<std::string>());
    }
  }
  if (s.contains("draft_model_path")) spec.draft_model_path = s["draft_model_path"].get<std::string>();
  if (s.contains("draftModelPath")) spec.draft_model_path = s["draftModelPath"].get<std::string>();
  if (s.contains("n_max")) spec.n_max = s["n_max"].get<int>();
  if (s.contains("nMax")) spec.n_max = s["nMax"].get<int>();
  if (s.contains("n_min")) spec.n_min = s["n_min"].get<int>();
  if (s.contains("nMin")) spec.n_min = s["nMin"].get<int>();
  if (s.contains("p_min")) spec.p_min = static_cast<float>(s["p_min"].get<double>());
  if (s.contains("pMin")) spec.p_min = static_cast<float>(s["pMin"].get<double>());
  return spec;
}

LoadOptions parse_load_options(const json& payload) {
  LoadOptions opts;
  auto apply = [&](const json& src) {
    if (src.contains("gpu_layers")) opts.gpu_layers = src["gpu_layers"].get<int>();
    if (src.contains("gpuLayers")) opts.gpu_layers = src["gpuLayers"].get<int>();
    if (src.contains("context_size")) opts.context_size = src["context_size"].get<int>();
    if (src.contains("contextSize")) opts.context_size = src["contextSize"].get<int>();
    if (src.contains("batch_size")) opts.batch_size = src["batch_size"].get<int>();
    if (src.contains("batchSize")) opts.batch_size = src["batchSize"].get<int>();
    if (src.contains("threads")) opts.threads = src["threads"].get<int>();
    if (src.contains("main_gpu")) opts.main_gpu = src["main_gpu"].get<int>();
    if (src.contains("mainGpu")) opts.main_gpu = src["mainGpu"].get<int>();
    if (src.contains("flash_attn")) opts.flash_attn = src["flash_attn"].get<int>();
    if (src.contains("flashAttn")) opts.flash_attn = src["flashAttn"].get<int>();
    if (src.contains("quant_policy")) opts.quant_policy = src["quant_policy"].get<std::string>();
    if (src.contains("mmproj_path")) opts.mmproj_path = src["mmproj_path"].get<std::string>();
    if (src.contains("mmprojPath")) opts.mmproj_path = src["mmprojPath"].get<std::string>();
  };
  apply(payload);
  if (payload.contains("loadOptions") && payload["loadOptions"].is_object()) {
    apply(payload["loadOptions"]);
  }
  // Top-level explicit fields beat nested loadOptions (e.g. CPU retry gpu_layers=0).
  if (payload.contains("gpu_layers")) opts.gpu_layers = payload["gpu_layers"].get<int>();
  if (payload.contains("gpuLayers")) opts.gpu_layers = payload["gpuLayers"].get<int>();
  if (payload.contains("context_size")) opts.context_size = payload["context_size"].get<int>();
  if (payload.contains("contextSize")) opts.context_size = payload["contextSize"].get<int>();
  if (payload.contains("batch_size")) opts.batch_size = payload["batch_size"].get<int>();
  if (payload.contains("batchSize")) opts.batch_size = payload["batchSize"].get<int>();
  if (payload.contains("threads")) opts.threads = payload["threads"].get<int>();
  if (payload.contains("main_gpu")) opts.main_gpu = payload["main_gpu"].get<int>();
  if (payload.contains("mainGpu")) opts.main_gpu = payload["mainGpu"].get<int>();
  if (payload.contains("flash_attn")) opts.flash_attn = payload["flash_attn"].get<int>();
  if (payload.contains("flashAttn")) opts.flash_attn = payload["flashAttn"].get<int>();
  opts.speculative = parse_speculative(payload);
  return opts;
}

}  // namespace

Engine::Engine(std::string models_dir)
    : registry_(std::move(models_dir)), worker_(nullptr), service_pool_(2) {
  worker_ = std::make_unique<InferenceWorker>(
      inference_, registry_, events_, [this](const std::string& line) { write_line(line); });
  worker_->start();
  register_commands();
}

Engine::~Engine() {
  if (worker_) worker_->stop();
  inference_.unload();
}

bool Engine::is_async_command(const std::string& type) {
  return type == "chat.generate" || type == "chat.embed" || type == "chat.send" ||
         type == "model.load" || type == "model.unload";
}

CommandResponse Engine::dispatch(const Command& cmd) {
  const auto t0 = std::chrono::steady_clock::now();
  const auto resp = dispatcher_.dispatch(cmd);
  const auto us = std::chrono::duration_cast<std::chrono::microseconds>(
                      std::chrono::steady_clock::now() - t0)
                      .count();
  dispatch_metrics_.record(us);
  return resp;
}

void Engine::set_event_sink(std::function<void(const std::string&)> sink) {
  event_sink_ = std::move(sink);
}

void Engine::write_line(const std::string& line) {
  std::lock_guard lock(io_mutex_);
  if (event_sink_) event_sink_(line);
}

void Engine::register_commands() {
  dispatcher_.register_handler("health", [this](const Command& cmd) {
    json data;
    data["ok"] = true;
    data["version"] = k_version;
    data["infer_available"] = InferenceService::infer_available();
    data["gpu_offload"] = InferenceService::gpu_offload_available();
    data["infer_server"] = InferenceService::infer_server_available();
    data["speculative"] = InferenceService::infer_server_available();
    data["dispatch_latency_ms"] =
        static_cast<double>(dispatch_metrics_.last_dispatch_us.load()) / 1000.0;
    data["dispatch_latency_max_ms"] =
        static_cast<double>(dispatch_metrics_.max_dispatch_us.load()) / 1000.0;
    data["inference_queue_depth"] = worker_->queue_depth();
    data["inference_busy"] = worker_->is_busy();
    data["service_pool_workers"] = service_pool_.worker_count();
#ifdef OMEGA_ENGINE_HAVE_INFER
    const auto caps = omega_infer_capabilities();
    data["vision"] = caps.vision != 0;
    data["paging"] = caps.paging != 0;
    data["paging_inflight"] = caps.paging_inflight != 0;
    data["layer_quant"] = caps.layer_quant != 0;
    data["multi_context"] = caps.multi_context != 0;
    data["compiled_backends"] = omega_infer_compiled_backends();
#else
    data["vision"] = false;
    data["paging"] = false;
    data["compiled_backends"] = "cpu";
#endif
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("model.list", [this](const Command& cmd) {
    registry_.rescan();
    json data;
    json models = json::array();
    for (const auto& m : registry_.list()) models.push_back(model_to_json(m));
    data["models"] = std::move(models);
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("model.load", [this](const Command& cmd) {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    const std::string model_id = payload.value("modelId", "");
    if (model_id.empty()) return fail(cmd, "modelId required");

    ModelRecord rec;
    if (!registry_.get(model_id, rec)) return fail(cmd, "model not found: " + model_id);

    LoadWork work;
    work.cmd = cmd;
    work.model_id = model_id;
    work.path = rec.path;
    work.options = parse_load_options(payload);
    worker_->enqueue_load(std::move(work));
    return CommandResponse{.id = cmd.id, .type = cmd.type, .success = true, .data_json = "{}"};
  });

  dispatcher_.register_handler("model.unload", [this](const Command& cmd) {
    json payload = json::object();
    try {
      if (!cmd.payload_json.empty()) payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    UnloadWork work;
    work.cmd = cmd;
    work.model_id = payload.value("modelId", "");
    work.unload_all = work.model_id.empty();
    worker_->enqueue_unload(std::move(work));
    return CommandResponse{.id = cmd.id, .type = cmd.type, .success = true, .data_json = "{}"};
  });

  dispatcher_.register_handler("model.loaded", [this](const Command& cmd) {
    json data;
    json models = json::array();
    json context_sizes = json::object();
    for (const auto& id : inference_.loaded_model_ids()) {
      models.push_back(id);
      const int ctx = inference_.loaded_context_size(id);
      if (ctx > 0) context_sizes[id] = ctx;
    }
    data["models"] = std::move(models);
    data["contextSizes"] = std::move(context_sizes);
    data["activeModelId"] = inference_.loaded_model_id();
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("model.delete", [this](const Command& cmd) {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    const std::string model_id = payload.value("modelId", "");
    if (model_id.empty()) return fail(cmd, "modelId required");
    if (worker_->is_busy()) {
      return fail(cmd, "inference busy — retry after the current chat or load finishes");
    }
    if (inference_.is_model_resident(model_id)) {
      inference_.unload_model(model_id);
    }
    std::string error;
    if (!registry_.remove(model_id, error)) return fail(cmd, error);
    json data;
    data["deleted"] = true;
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("chat.generate", [this](const Command& cmd) -> CommandResponse {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    GenerateWork work;
    work.cmd = cmd;
    work.model_id = payload.value("model", "");
    work.prompt = payload.value("prompt", "");
    if (work.model_id.empty() || work.prompt.empty()) {
      return fail(cmd, "model and prompt required");
    }
    if (payload.contains("sampling") && payload["sampling"].is_object()) {
      const auto& s = payload["sampling"];
      if (s.contains("temperature")) work.sampling.temperature = s["temperature"].get<float>();
      if (s.contains("max_tokens")) work.sampling.max_tokens = s["max_tokens"].get<int>();
      if (s.contains("top_p")) work.sampling.top_p = s["top_p"].get<float>();
      if (s.contains("top_k")) work.sampling.top_k = s["top_k"].get<int>();
    }
    work.sampling = InferenceService::default_sampling(work.sampling);
    worker_->enqueue_generate(std::move(work));
    return CommandResponse{.id = cmd.id, .type = cmd.type, .success = true, .data_json = "{}"};
  });

  dispatcher_.register_handler("chat.embed", [this](const Command& cmd) -> CommandResponse {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    EmbedWork work;
    work.cmd = cmd;
    work.model_id = payload.value("model", "");
    work.text = payload.value("text", "");
    if (work.model_id.empty() || work.text.empty()) {
      return fail(cmd, "model and text required");
    }
    worker_->enqueue_embed(std::move(work));
    return CommandResponse{.id = cmd.id, .type = cmd.type, .success = true, .data_json = "{}"};
  });

  dispatcher_.register_handler("chat.send", [this](const Command& cmd) -> CommandResponse {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    SendWork work;
    work.cmd = cmd;
    work.model_id = payload.value("model", "");
    if (work.model_id.empty()) return fail(cmd, "model required");
    if (payload.contains("messages") && payload["messages"].is_array()) {
      for (const auto& m : payload["messages"]) {
        ChatMessage msg;
        msg.role = m.value("role", "");
        msg.content = m.value("content", "");
        if (m.contains("imagePaths") && m["imagePaths"].is_array()) {
          for (const auto& p : m["imagePaths"]) {
            if (p.is_string()) msg.image_paths.push_back(p.get<std::string>());
          }
        }
        if (m.contains("images") && m["images"].is_array()) {
          for (const auto& p : m["images"]) {
            if (p.is_string()) msg.images.push_back(p.get<std::string>());
          }
        }
        work.messages.push_back(std::move(msg));
      }
    }
    if (work.messages.empty()) return fail(cmd, "messages required");
    if (payload.contains("sampling") && payload["sampling"].is_object()) {
      const auto& s = payload["sampling"];
      if (s.contains("temperature")) work.sampling.temperature = s["temperature"].get<float>();
      if (s.contains("max_tokens")) work.sampling.max_tokens = s["max_tokens"].get<int>();
      if (s.contains("top_p")) work.sampling.top_p = s["top_p"].get<float>();
      if (s.contains("top_k")) work.sampling.top_k = s["top_k"].get<int>();
    }
    if (payload.contains("enableThinking")) {
      work.enable_thinking = payload["enableThinking"].get<bool>();
    }
    if (payload.contains("promptFormat") && payload["promptFormat"].is_string()) {
      work.use_simple_prompt = payload["promptFormat"].get<std::string>() == "simple";
    }
    if (payload.contains("loadOptions") && payload["loadOptions"].is_object()) {
      work.load_options = parse_load_options(payload["loadOptions"]);
    }
    work.sampling = InferenceService::default_sampling(work.sampling);
    worker_->enqueue_send(std::move(work));
    return CommandResponse{.id = cmd.id, .type = cmd.type, .success = true, .data_json = "{}"};
  });

  dispatcher_.register_handler("chat.abort", [this](const Command& cmd) -> CommandResponse {
    json payload = json::object();
    try {
      if (!cmd.payload_json.empty()) payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    std::string target = payload.value("sessionId", "");
    if (target.empty()) target = payload.value("requestId", "");
    if (target.empty()) target = cmd.id;
    worker_->abort(target);
    json data;
    data["aborted"] = true;
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("media.capabilities", [this](const Command& cmd) {
    return ok_json(cmd, media::capabilities_json());
  });

  dispatcher_.register_handler("tts.generate", [this](const Command& cmd) {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    std::string err;
    const json data = media::tts_generate(registry_, payload, err);
    if (!data.value("ok", false)) return fail(cmd, err.empty() ? "tts.generate failed" : err);
    return ok_json(cmd, data);
  });

  dispatcher_.register_handler("image.generate", [this](const Command& cmd) {
    json payload;
    try {
      payload = json::parse(cmd.payload_json);
    } catch (...) {
      return fail(cmd, "invalid payload");
    }
    std::string err;
    const json data = media::image_generate(registry_, payload, err);
    if (!data.value("ok", false)) {
      return fail(cmd, err.empty() ? "image.generate failed" : err);
    }
    return ok_json(cmd, data);
  });
}

}  // namespace omega::engine
