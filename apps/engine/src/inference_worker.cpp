#include "omega/engine/inference_worker.hpp"

#include <chrono>
#include <nlohmann/json.hpp>
#include <sstream>
#include "omega/engine/event_bus.hpp"
#include "omega/engine/json_protocol.hpp"
#include "omega/engine/json_safe.hpp"
#include "omega/engine/model_registry.hpp"

namespace omega::engine {

namespace {

using json = nlohmann::json;

using SteadyClock = std::chrono::steady_clock;

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

double steady_elapsed_ms(SteadyClock::time_point from, SteadyClock::time_point to) {
  return std::chrono::duration<double, std::milli>(to - from).count();
}

struct StreamTiming {
  SteadyClock::time_point start{};
  SteadyClock::time_point first_token{};
  bool have_first{false};
};

CommandResponse fail(const Command& cmd, const std::string& message) {
  return CommandResponse{.id = cmd.id,
                       .type = cmd.type,
                       .success = false,
                       .data_json = "{}",
                       .error = message};
}

CommandResponse ok_data(const Command& cmd, const json& data) {
  return CommandResponse{
      .id = cmd.id, .type = cmd.type, .success = true, .data_json = json_dump_safe(data)};
}

int estimate_messages_tokens(const std::vector<ChatMessage>& messages) {
  int total = 0;
  for (const auto& m : messages) {
    if (m.content.empty()) continue;
    total += std::max(1, static_cast<int>(m.content.size()) / 4);
  }
  return total;
}

void apply_stats_to_json(json& obj, const GenerationStats& stats) {
  if (stats.prompt_tokens > 0) {
    obj["tokens_in"] = stats.prompt_tokens;
    obj["prompt_tokens"] = stats.prompt_tokens;
  }
  if (stats.completion_tokens > 0) {
    obj["tokens_out"] = stats.completion_tokens;
    obj["completion_tokens"] = stats.completion_tokens;
  }
  const double prompt_ms =
      stats.prompt_ms_f > 0 ? stats.prompt_ms_f
                            : (stats.prompt_ms > 0 ? static_cast<double>(stats.prompt_ms) : 0.0);
  const double gen_ms =
      stats.gen_ms_f > 0 ? stats.gen_ms_f
                         : (stats.gen_ms > 0 ? static_cast<double>(stats.gen_ms) : 0.0);
  if (prompt_ms > 0) obj["prompt_ms"] = prompt_ms;
  if (gen_ms > 0) obj["gen_ms"] = gen_ms;
}

void attach_live_stats_json(json& payload, const GenerationStats& stats, const char* phase) {
  apply_stats_to_json(payload, stats);
  payload["measured"] = true;
  if (phase && *phase) payload["phase"] = phase;
}

void refresh_live_generation_stats(GenerationStats& stats, StreamTiming& timing, int index) {
  if (index < 0) return;
  const auto now = SteadyClock::now();
  if (!timing.have_first) {
    timing.have_first = true;
    timing.first_token = now;
    stats.prompt_ms_f = steady_elapsed_ms(timing.start, now);
    stats.prompt_ms = static_cast<int64_t>(stats.prompt_ms_f);
  }
  stats.completion_tokens = std::max(stats.completion_tokens, index + 1);
  if (timing.have_first) {
    stats.gen_ms_f = steady_elapsed_ms(timing.first_token, now);
    stats.gen_ms = static_cast<int64_t>(stats.gen_ms_f);
  }
}

bool ensure_model_loaded(InferenceService& infer, ModelRegistry& registry,
                         const std::string& model_id, const LoadOptions& load_options,
                         std::string& error) {
  ModelRecord rec;
  if (!registry.get(model_id, rec)) {
    error = "model not found: " + model_id;
    return false;
  }
  return infer.load(model_id, rec.path, load_options, error);
}

}  // namespace

InferenceWorker::InferenceWorker(InferenceService& infer, ModelRegistry& registry, EventBus& events,
                                 WriteLineFn write_line)
    : infer_(infer), registry_(registry), events_(events), write_line_(std::move(write_line)) {}

InferenceWorker::~InferenceWorker() { stop(); }

void InferenceWorker::start() {
  stop_ = false;
  thread_ = std::thread([this] { run(); });
}

void InferenceWorker::stop() {
  stop_ = true;
  queue_cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void InferenceWorker::enqueue_generate(GenerateWork work) {
  {
    std::lock_guard lock(queue_mutex_);
    queue_.push(Job{.kind = Job::Kind::Generate, .generate = std::move(work)});
  }
  queue_cv_.notify_one();
}

void InferenceWorker::enqueue_embed(EmbedWork work) {
  {
    std::lock_guard lock(queue_mutex_);
    queue_.push(Job{.kind = Job::Kind::Embed, .embed = std::move(work)});
  }
  queue_cv_.notify_one();
}

void InferenceWorker::enqueue_send(SendWork work) {
  {
    std::lock_guard lock(queue_mutex_);
    queue_.push(Job{.kind = Job::Kind::Send, .send = std::move(work)});
  }
  queue_cv_.notify_one();
}

void InferenceWorker::enqueue_load(LoadWork work) {
  {
    std::lock_guard lock(queue_mutex_);
    queue_.push(Job{.kind = Job::Kind::Load, .load = std::move(work)});
  }
  queue_cv_.notify_one();
}

void InferenceWorker::enqueue_unload(UnloadWork work) {
  {
    std::lock_guard lock(queue_mutex_);
    queue_.push(Job{.kind = Job::Kind::Unload, .unload = std::move(work)});
  }
  queue_cv_.notify_one();
}

std::size_t InferenceWorker::queue_depth() const {
  std::lock_guard lock(queue_mutex_);
  return queue_.size();
}

bool InferenceWorker::is_busy() const { return busy_.load(); }

void InferenceWorker::abort(const std::string& cmd_id) {
  std::lock_guard lock(active_mutex_);
  if (active_cmd_id_ == cmd_id) {
    cancel_flag_.store(true);
  }
}

void InferenceWorker::run() {
  while (true) {
    Job job;
    {
      std::unique_lock lock(queue_mutex_);
      queue_cv_.wait(lock, [this] { return stop_ || !queue_.empty(); });
      if (stop_ && queue_.empty()) return;
      job = std::move(queue_.front());
      queue_.pop();
    }
    if (job.kind == Job::Kind::Load) {
      try {
        process_load(job.load);
      } catch (const std::exception& ex) {
        write_response(fail(job.load.cmd, ex.what()));
      } catch (...) {
        write_response(fail(job.load.cmd, "model load failed"));
      }
    } else if (job.kind == Job::Kind::Unload) {
      try {
        process_unload(job.unload);
      } catch (const std::exception& ex) {
        write_response(fail(job.unload.cmd, ex.what()));
      } catch (...) {
        write_response(fail(job.unload.cmd, "model unload failed"));
      }
    } else if (job.kind == Job::Kind::Generate) {
      try {
        process_generate(job.generate);
      } catch (const std::exception& ex) {
        write_response(fail(job.generate.cmd, ex.what()));
      } catch (...) {
        write_response(fail(job.generate.cmd, "generate failed"));
      }
    } else if (job.kind == Job::Kind::Embed) {
      try {
        process_embed(job.embed);
      } catch (const std::exception& ex) {
        write_response(fail(job.embed.cmd, ex.what()));
      } catch (...) {
        write_response(fail(job.embed.cmd, "embed failed"));
      }
    } else {
      try {
        process_send(job.send);
      } catch (const std::exception& ex) {
        write_response(fail(job.send.cmd, ex.what()));
      } catch (...) {
        write_response(fail(job.send.cmd, "chat failed"));
      }
    }
  }
}

void InferenceWorker::emit_chunk(const std::string& session_id, const std::string& text,
                                 int index, const GenerationStats* stats, const char* phase) {
  json payload;
  payload["sessionId"] = session_id;
  payload["text"] = text;
  if (index >= 0) payload["index"] = index;
  if (stats) attach_live_stats_json(payload, *stats, phase);
  Event ev;
  ev.type = "ChatChunkReceived";
  ev.at_ms = now_ms();
  ev.payload_json = json_dump_safe(payload);
  events_.emit(ev);
  write_line_(JsonProtocol::serialize_event(ev));
}

void InferenceWorker::emit_load_progress(const std::string& model_id, int percent,
                                         const std::string& message) {
  json payload;
  payload["modelId"] = model_id;
  payload["percent"] = percent;
  if (!message.empty()) payload["message"] = message;
  Event ev;
  ev.type = "ModelLoadProgress";
  ev.at_ms = now_ms();
  ev.payload_json = json_dump_safe(payload);
  events_.emit(ev);
  write_line_(JsonProtocol::serialize_event(ev));
}

void InferenceWorker::write_response(const CommandResponse& resp) {
  write_line_(JsonProtocol::serialize_response(resp));
}

void InferenceWorker::process_load(const LoadWork& work) {
  const auto& cmd = work.cmd;
  busy_.store(true);
  {
    std::lock_guard lock(active_mutex_);
    active_cmd_id_ = cmd.id;
    cancel_flag_.store(false);
  }
  emit_load_progress(work.model_id, 10, "Loading model…");
  std::string error;
  const LoadProgressCallback on_progress = [this, &work](int percent, const std::string& message) {
    emit_load_progress(work.model_id, percent, message);
  };
  if (!infer_.load(work.model_id, work.path, work.options, error, on_progress)) {
    busy_.store(false);
    write_response(fail(cmd, error));
    return;
  }
  json ev_payload;
  ev_payload["modelId"] = work.model_id;
  Event ev;
  ev.type = "ModelLoaded";
  ev.at_ms = now_ms();
  ev.payload_json = json_dump_safe(ev_payload);
  events_.emit(ev);
  write_line_(JsonProtocol::serialize_event(ev));
  emit_load_progress(work.model_id, 100, "Ready");
  json data;
  data["modelId"] = work.model_id;
  data["loaded"] = true;
  write_response(ok_data(cmd, data));
  busy_.store(false);
}

void InferenceWorker::process_unload(const UnloadWork& work) {
  const auto& cmd = work.cmd;
  busy_.store(true);
  json data;
  data["unloaded"] = true;

  if (!infer_.is_loaded()) {
    busy_.store(false);
    write_response(ok_data(cmd, data));
    return;
  }

  if (work.unload_all) {
    const std::string unloaded_id = infer_.loaded_model_id();
    infer_.unload();
    if (!unloaded_id.empty()) {
      json ev_payload;
      ev_payload["modelId"] = unloaded_id;
      Event ev;
      ev.type = "ModelUnloaded";
      ev.at_ms = now_ms();
      ev.payload_json = json_dump_safe(ev_payload);
      events_.emit(ev);
      write_line_(JsonProtocol::serialize_event(ev));
    }
    busy_.store(false);
    write_response(ok_data(cmd, data));
    return;
  }

  if (!infer_.is_model_resident(work.model_id)) {
    busy_.store(false);
    write_response(ok_data(cmd, data));
    return;
  }

  infer_.unload_model(work.model_id);
  json ev_payload;
  ev_payload["modelId"] = work.model_id;
  Event ev;
  ev.type = "ModelUnloaded";
  ev.at_ms = now_ms();
  ev.payload_json = json_dump_safe(ev_payload);
  events_.emit(ev);
  write_line_(JsonProtocol::serialize_event(ev));
  busy_.store(false);
  write_response(ok_data(cmd, data));
}

void InferenceWorker::process_generate(const GenerateWork& work) {
  const auto& cmd = work.cmd;
  busy_.store(true);
  {
    std::lock_guard lock(active_mutex_);
    active_cmd_id_ = cmd.id;
    cancel_flag_.store(false);
  }
  std::string error;
  if (!ensure_model_loaded(infer_, registry_, work.model_id, LoadOptions{}, error)) {
    busy_.store(false);
    write_response(fail(cmd, error));
    return;
  }

  json started;
  started["sessionId"] = cmd.id;
  started["model"] = work.model_id;
  Event start_ev;
  start_ev.type = "ChatStarted";
  start_ev.at_ms = now_ms();
  start_ev.payload_json = json_dump_safe(started);
  events_.emit(start_ev);
  write_line_(JsonProtocol::serialize_event(start_ev));

  std::string full_text;
  GenerationStats stats;
  stats.prompt_tokens = std::max(1, static_cast<int>(work.prompt.size()) / 4);
  StreamTiming timing;
  timing.start = SteadyClock::now();
  const auto on_token = [&](const TokenChunk& chunk) -> bool {
    if (cancel_flag_.load()) return false;
    refresh_live_generation_stats(stats, timing, chunk.index);
    emit_chunk(cmd.id, chunk.text, chunk.index, &stats, "decode");
    return true;
  };

  if (!infer_.generate(work.prompt, work.sampling, on_token, full_text, error, &stats)) {
    if (cancel_flag_.load()) {
      busy_.store(false);
      write_response(fail(cmd, "aborted"));
      return;
    }
    json err_payload;
    err_payload["sessionId"] = cmd.id;
    err_payload["error"] = error;
    Event err_ev;
    err_ev.type = "ChatError";
    err_ev.at_ms = now_ms();
    err_ev.payload_json = json_dump_safe(err_payload);
    events_.emit(err_ev);
    write_line_(JsonProtocol::serialize_event(err_ev));
    write_response(fail(cmd, error));
    busy_.store(false);
    return;
  }

  json finished;
  finished["sessionId"] = cmd.id;
  finished["text"] = full_text;
  apply_stats_to_json(finished, stats);
  Event done_ev;
  done_ev.type = "ChatFinished";
  done_ev.at_ms = now_ms();
  done_ev.payload_json = json_dump_safe(finished);
  events_.emit(done_ev);
  write_line_(JsonProtocol::serialize_event(done_ev));

  json data;
  data["text"] = full_text;
  apply_stats_to_json(data, stats);
  write_response(ok_data(cmd, data));
  busy_.store(false);
}

void InferenceWorker::process_embed(const EmbedWork& work) {
  const auto& cmd = work.cmd;
  busy_.store(true);
  {
    std::lock_guard lock(active_mutex_);
    active_cmd_id_ = cmd.id;
    cancel_flag_.store(false);
  }
  std::string error;
  if (!ensure_model_loaded(infer_, registry_, work.model_id, LoadOptions{}, error)) {
    busy_.store(false);
    write_response(fail(cmd, error));
    return;
  }
  std::vector<float> vector;
  if (!infer_.embed(work.text, vector, error)) {
    busy_.store(false);
    write_response(fail(cmd, error));
    return;
  }
  json data;
  data["vector"] = vector;
  write_response(ok_data(cmd, data));
  busy_.store(false);
}

void InferenceWorker::process_send(const SendWork& work) {
  const auto& cmd = work.cmd;
  busy_.store(true);
  {
    std::lock_guard lock(active_mutex_);
    active_cmd_id_ = cmd.id;
    cancel_flag_.store(false);
  }
  std::string error;
  if (!ensure_model_loaded(infer_, registry_, work.model_id, work.load_options, error)) {
    busy_.store(false);
    write_response(fail(cmd, error));
    return;
  }

  json started;
  started["sessionId"] = cmd.id;
  started["model"] = work.model_id;
  Event start_ev;
  start_ev.type = "ChatStarted";
  start_ev.at_ms = now_ms();
  start_ev.payload_json = json_dump_safe(started);
  events_.emit(start_ev);
  write_line_(JsonProtocol::serialize_event(start_ev));

  std::string full_text;
  GenerationStats stats;
  stats.prompt_tokens = estimate_messages_tokens(work.messages);
  StreamTiming timing;
  timing.start = SteadyClock::now();
  const auto on_token = [&](const TokenChunk& chunk) -> bool {
    if (cancel_flag_.load()) return false;
    refresh_live_generation_stats(stats, timing, chunk.index);
    emit_chunk(cmd.id, chunk.text, chunk.index, &stats, "decode");
    return true;
  };

  bool ok = false;
  try {
    ok = infer_.chat(work.messages, work.sampling, on_token, full_text, error, work.enable_thinking,
                     work.use_simple_prompt, &stats);
  } catch (const std::exception& ex) {
    error = ex.what();
    ok = false;
  } catch (...) {
    error = "chat inference failed";
    ok = false;
  }

  if (!ok) {
    if (cancel_flag_.load()) {
      busy_.store(false);
      write_response(fail(cmd, "aborted"));
      return;
    }
    json err_payload;
    err_payload["sessionId"] = cmd.id;
    err_payload["error"] = error;
    Event err_ev;
    err_ev.type = "ChatError";
    err_ev.at_ms = now_ms();
    err_ev.payload_json = json_dump_safe(err_payload);
    events_.emit(err_ev);
    write_line_(JsonProtocol::serialize_event(err_ev));
    write_response(fail(cmd, error));
    busy_.store(false);
    return;
  }

  json finished;
  finished["sessionId"] = cmd.id;
  finished["text"] = full_text;
  apply_stats_to_json(finished, stats);
  Event done_ev;
  done_ev.type = "ChatFinished";
  done_ev.at_ms = now_ms();
  done_ev.payload_json = json_dump_safe(finished);
  events_.emit(done_ev);
  write_line_(JsonProtocol::serialize_event(done_ev));

  json data;
  data["text"] = full_text;
  apply_stats_to_json(data, stats);
  write_response(ok_data(cmd, data));
  busy_.store(false);
}

}  // namespace omega::engine
