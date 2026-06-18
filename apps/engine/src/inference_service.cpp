#include <atomic>
#include <chrono>
#include <filesystem>
#include <vector>
#include <algorithm>

#include "omega/engine/infer_server_backend.hpp"
#include "omega/engine/inference_service.hpp"

#ifdef OMEGA_ENGINE_HAVE_INFER
#include "omega_infer.h"
#endif

namespace omega::engine {

namespace {

constexpr const char* k_media_marker = "<__media__>";

namespace fs = std::filesystem;

std::string to_lower_ascii(std::string s) {
  for (auto& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::string gguf_stem(const std::string& path) {
  const fs::path p(path);
  std::string stem = p.stem().string();
  const auto q = stem.find("-q");
  if (q != std::string::npos) stem = stem.substr(0, q);
  return to_lower_ascii(stem);
}

std::string find_mmproj_for_gguf(const std::string& gguf_path) {
  std::error_code ec;
  const fs::path dir = fs::path(gguf_path).parent_path();
  if (dir.empty() || !fs::is_directory(dir, ec)) return {};
  const std::string stem = gguf_stem(gguf_path);
  std::string fallback;
  for (const auto& entry : fs::directory_iterator(dir, ec)) {
    if (ec || !entry.is_regular_file()) continue;
    const fs::path fp = entry.path();
    if (fp.extension() != ".gguf") continue;
    const std::string full = fp.string();
    if (full == gguf_path) continue;
    const std::string name = to_lower_ascii(fp.filename().string());
    if (name.find("mmproj") == std::string::npos && name.find("clip") == std::string::npos &&
        name.find("-vision") == std::string::npos) {
      continue;
    }
    const std::string proj_stem = gguf_stem(full);
    if (name.find(stem) != std::string::npos || stem.find(proj_stem) != std::string::npos) {
      return full;
    }
    if (fallback.empty()) fallback = full;
  }
  return fallback;
}

#ifdef OMEGA_ENGINE_HAVE_INFER
int estimate_text_tokens(const std::string& text) {
  if (text.empty()) return 0;
  return std::max(1, static_cast<int>(text.size()) / 4);
}

int estimate_messages_tokens(const std::vector<ChatMessage>& messages) {
  int total = 0;
  for (const auto& m : messages) total += estimate_text_tokens(m.content);
  return total;
}

struct TokenState {
  std::string* full_text = nullptr;
  TokenCallback cb;
  std::atomic<bool>* cancel = nullptr;
  GenerationStats* stats = nullptr;
  int max_index = -1;
};

int omega_engine_token_cb(const char* text, int index, void* user) {
  auto* st = static_cast<TokenState*>(user);
  if (!st || !text) return 0;
  if (st->cancel && st->cancel->load()) return -1;
  const TokenChunk chunk{std::string(text), index};
  st->max_index = std::max(st->max_index, index);
  if (st->full_text) *st->full_text += chunk.text;
  if (st->cb && !st->cb(chunk)) return -1;
  if (st->stats && index >= 0) {
    st->stats->completion_tokens = std::max(st->stats->completion_tokens, index + 1);
  }
  return 0;
}

void finalize_generation_stats(GenerationStats* stats, const std::string& full_text, int max_index) {
  if (!stats) return;
  if (stats->completion_tokens <= 0) {
    if (max_index >= 0) {
      stats->completion_tokens = max_index + 1;
    } else if (!full_text.empty()) {
      stats->completion_tokens = estimate_text_tokens(full_text);
    }
  }
}

bool load_resident_handle(const std::string& path, LoadOptions& cfg, void*& out_handle,
                          std::string& error, LoadProgressCallback on_progress) {
  const char* quant = cfg.quant_policy.empty() ? nullptr : cfg.quant_policy.c_str();
  std::string mmproj = cfg.mmproj_path;
  const char* mmproj_c = mmproj.empty() ? nullptr : mmproj.c_str();

  auto try_load = [&](int gpu_layers, int ctx_size, int flash_attn) -> omega_model_t* {
    omega_load_params_t lp{};
    lp.n_ctx = ctx_size;
    lp.n_gpu_layers = gpu_layers;
    lp.n_batch = std::min(cfg.batch_size, ctx_size);
    lp.n_threads = cfg.threads;
    lp.main_gpu = cfg.main_gpu;
    lp.flash_attn = flash_attn;
    lp.quant_policy = quant;
    lp.mmproj_path = mmproj_c;
    if (on_progress && gpu_layers > 0) {
      lp.progress_callback = +[](float progress, void* user) -> bool {
        const auto* cb = static_cast<const LoadProgressCallback*>(user);
        if (!cb || !*cb) return true;
        const int pct = 28 + static_cast<int>(progress * 52.f);
        (*cb)(std::min(80, pct),
              progress < 0.95f ? "Loading weights on GPU…" : "Creating context…");
        return true;
      };
      lp.progress_callback_user_data = &on_progress;
    }
    return omega_model_load(path.c_str(), &lp);
  };

  const int requested_gpu = cfg.gpu_layers;
  const int requested_ctx = cfg.context_size > 0 ? cfg.context_size : 8192;
  const int requested_flash = cfg.flash_attn;

  std::vector<int> gpu_tiers;
  auto push_unique = [](std::vector<int>& values, int value) {
    if (std::find(values.begin(), values.end(), value) == values.end()) values.push_back(value);
  };
  if (requested_gpu <= 0) {
    push_unique(gpu_tiers, 0);
  } else {
    push_unique(gpu_tiers, requested_gpu);
    push_unique(gpu_tiers, 0);
  }

  std::vector<int> ctx_tiers;
  push_unique(ctx_tiers, requested_ctx);
  for (const int step : {4096, 2048, 1024}) {
    if (step < requested_ctx) push_unique(ctx_tiers, step);
  }

  std::vector<int> flash_tiers;
  push_unique(flash_tiers, requested_flash);
  if (requested_flash != 0) push_unique(flash_tiers, 0);

  bool tried_fallback = false;
  bool cpu_backend_reset = false;
  for (size_t gpu_idx = 0; gpu_idx < gpu_tiers.size(); ++gpu_idx) {
    const int gpu_layers = gpu_tiers[gpu_idx];
    if (gpu_layers == 0 && requested_gpu > 0 && gpu_idx > 0 && !cpu_backend_reset) {
      omega_infer_reinit_cpu_only();
      cpu_backend_reset = true;
    }
    for (size_t ctx_idx = 0; ctx_idx < ctx_tiers.size(); ++ctx_idx) {
      const int ctx_size = ctx_tiers[ctx_idx];
      for (size_t flash_idx = 0; flash_idx < flash_tiers.size(); ++flash_idx) {
        const int flash_attn = flash_tiers[flash_idx];
        const bool is_fallback = gpu_idx > 0 || ctx_idx > 0 || flash_idx > 0;
        if (is_fallback) {
          tried_fallback = true;
          if (on_progress) {
            std::string msg;
            if (gpu_layers == 0 && requested_gpu > 0) {
              msg = "Retrying on CPU…";
            } else if (gpu_layers != requested_gpu) {
              msg = "Retrying with " + std::to_string(gpu_layers) + " GPU layers…";
            } else if (ctx_size != requested_ctx) {
              msg = "Retrying with context " + std::to_string(ctx_size) + "…";
            } else if (flash_attn == 0 && requested_flash != 0) {
              msg = "Retrying with flash attention disabled…";
            } else {
              msg = "Retrying model load…";
            }
            on_progress(20, msg);
          }
        }
        omega_model_t* m = try_load(gpu_layers, ctx_size, flash_attn);
        if (m) {
          cfg.gpu_layers = gpu_layers;
          cfg.context_size = ctx_size;
          cfg.flash_attn = flash_attn;
          out_handle = m;
          error.clear();
          return true;
        }
      }
    }
  }

  if (!out_handle) {
    error = tried_fallback
                ? "omega_model_load failed for " + path +
                      " (context init crashed or failed — see omega-engine-stderr.log for "
                      "libomega_infer / SEH ACCESS_VIOLATION / llama_init_from_model lines)"
                : "omega_model_load failed for " + path;
    return false;
  }
  return true;
}

bool load_options_affect_handle(const LoadOptions& prev, const LoadOptions& next) {
  return prev.context_size != next.context_size || prev.gpu_layers != next.gpu_layers ||
         prev.batch_size != next.batch_size || prev.threads != next.threads ||
         prev.main_gpu != next.main_gpu || prev.flash_attn != next.flash_attn ||
         prev.quant_policy != next.quant_policy || prev.mmproj_path != next.mmproj_path;
}
#endif

}  // namespace

int64_t InferenceService::now_ms() const {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

void InferenceService::clear_infer_server_locked() {
  if (server_) server_->stop();
  backend_ = InferBackend::None;
}

void InferenceService::clear_residents_locked() {
  for (auto& r : residents_) free_resident_locked(r);
  residents_.clear();
}

void InferenceService::free_resident_locked(ResidentModel& model) {
#ifdef OMEGA_ENGINE_HAVE_INFER
  if (model.handle) {
    omega_model_free(static_cast<omega_model_t*>(model.handle));
    model.handle = nullptr;
  }
#else
  (void)model;
#endif
}

InferenceService::ResidentModel* InferenceService::find_resident_locked(const std::string& id) {
  for (auto& r : residents_) {
    if (r.id == id) return &r;
  }
  return nullptr;
}

const InferenceService::ResidentModel* InferenceService::find_resident_locked(
    const std::string& id) const {
  for (const auto& r : residents_) {
    if (r.id == id) return &r;
  }
  return nullptr;
}

bool InferenceService::evict_lru_locked(const std::string& except_id) {
  if (residents_.empty()) return true;
  size_t victim = 0;
  int64_t oldest = residents_[0].last_used_ms;
  for (size_t i = 0; i < residents_.size(); ++i) {
    if (residents_[i].id == except_id) continue;
    if (residents_[i].last_used_ms <= oldest) {
      oldest = residents_[i].last_used_ms;
      victim = i;
    }
  }
  if (residents_[victim].id == except_id) return false;
  if (active_id_ == residents_[victim].id) active_id_.clear();
  free_resident_locked(residents_[victim]);
  residents_.erase(residents_.begin() + static_cast<std::ptrdiff_t>(victim));
  return true;
}

void InferenceService::touch_locked(ResidentModel& model) { model.last_used_ms = now_ms(); }

void* InferenceService::active_handle_locked() {
  if (backend_ != InferBackend::LibOmega) return nullptr;
  if (auto* r = find_resident_locked(active_id_)) return r->handle;
  return nullptr;
}

bool InferenceService::activate_locked(const std::string& id, std::string& error) {
  if (backend_ == InferBackend::InferServer) {
    if (active_id_ == id) return true;
    error = "infer-server backend is exclusive";
    return false;
  }
  auto* r = find_resident_locked(id);
  if (!r || !r->handle) {
    error = "model not resident: " + id;
    return false;
  }
  active_id_ = id;
  backend_ = InferBackend::LibOmega;
  touch_locked(*r);
  return true;
}

bool InferenceService::infer_available() {
#ifdef OMEGA_ENGINE_HAVE_INFER
  if (omega_infer_available() != 0) return true;
#endif
  return InferServerBackend::infer_binary_available();
}

bool InferenceService::gpu_offload_available() {
#ifdef OMEGA_ENGINE_HAVE_INFER
  return omega_infer_gpu_offload_available() != 0;
#else
  return false;
#endif
}

bool InferenceService::infer_server_available() {
  return InferServerBackend::infer_binary_available();
}

bool InferenceService::uses_infer_server() const {
  std::lock_guard lock(mutex_);
  return backend_ == InferBackend::InferServer;
}

std::string InferenceService::infer_unavailable_reason() {
#ifdef OMEGA_ENGINE_HAVE_INFER
  if (omega_infer_available() != 0) return {};
#endif
  if (InferServerBackend::infer_binary_available()) return {};
  return "libomega_infer and omega-infer unavailable; rebuild with -LinkInfer and bundle resources/bin";
}

bool InferenceService::is_loaded() const {
  std::lock_guard lock(mutex_);
  return backend_ != InferBackend::None;
}

const std::string& InferenceService::loaded_model_id() const {
  std::lock_guard lock(mutex_);
  return active_id_;
}

std::vector<std::string> InferenceService::loaded_model_ids() const {
  std::lock_guard lock(mutex_);
  std::vector<std::string> ids;
  if (backend_ == InferBackend::InferServer && !active_id_.empty()) {
    ids.push_back(active_id_);
    return ids;
  }
  ids.reserve(residents_.size());
  for (const auto& r : residents_) ids.push_back(r.id);
  return ids;
}

bool InferenceService::is_model_resident(const std::string& model_id) const {
  std::lock_guard lock(mutex_);
  if (backend_ == InferBackend::InferServer) return active_id_ == model_id;
  return find_resident_locked(model_id) != nullptr;
}

int InferenceService::loaded_context_size(const std::string& model_id) const {
  std::lock_guard lock(mutex_);
  const ResidentModel* r = find_resident_locked(model_id);
  if (!r) return 0;
#ifdef OMEGA_ENGINE_HAVE_INFER
  if (r->handle) {
    const int n = omega_model_context_size(static_cast<omega_model_t*>(r->handle));
    if (n > 0) return n;
  }
#endif
  if (r->options.context_size > 0) return r->options.context_size;
  return 0;
}

SamplingOptions InferenceService::default_sampling(const SamplingOptions& in) {
  SamplingOptions out = in;
  if (out.temperature <= 0.0f) out.temperature = 0.8f;
  if (out.top_p <= 0.0f) out.top_p = 0.95f;
  if (out.top_k <= 0) out.top_k = 40;
  if (out.max_tokens <= 0) out.max_tokens = 512;
  return out;
}

LoadOptions InferenceService::default_load(const LoadOptions& in) {
  LoadOptions out = in;
  if (out.context_size <= 0) out.context_size = 8192;
  if (out.batch_size <= 0) out.batch_size = 2048;
  if (out.gpu_layers < 0) out.gpu_layers = 999;
  if (out.threads <= 0) out.threads = 0;
  return out;
}

bool InferenceService::load(const std::string& model_id, const std::string& path,
                            const LoadOptions& opts, std::string& error,
                            LoadProgressCallback on_progress) {
  const LoadOptions cfg = default_load(opts);
  std::unique_lock lock(mutex_);

  if (speculative_uses_infer_server(cfg.speculative)) {
    clear_residents_locked();
    if (!InferServerBackend::infer_binary_available()) {
      error = "MTP/speculative decoding requires omega-infer in PATH or OMEGA_INFER_BIN";
      return false;
    }
    if (!server_) server_ = std::make_unique<InferServerBackend>();
    clear_infer_server_locked();
    SpeculativeOptions spec = default_speculative(cfg.speculative);
    if (spec.draft_model_path.empty()) spec.draft_model_path = path;
    if (!server_->start(path, cfg, spec, error)) return false;
    backend_ = InferBackend::InferServer;
    active_id_ = model_id;
    return true;
  }

#ifdef OMEGA_ENGINE_HAVE_INFER
  if (omega_infer_available() == 0) {
    error = infer_unavailable_reason();
    return false;
  }

  clear_infer_server_locked();

  if (auto* existing = find_resident_locked(model_id)) {
    if (existing->path == path && !load_options_affect_handle(existing->options, cfg)) {
      existing->options = cfg;
      return activate_locked(model_id, error);
    }
    if (active_id_ == model_id) {
      active_id_.clear();
      backend_ = InferBackend::None;
    }
    free_resident_locked(*existing);
    for (size_t i = 0; i < residents_.size(); ++i) {
      if (residents_[i].id != model_id) continue;
      residents_.erase(residents_.begin() + static_cast<std::ptrdiff_t>(i));
      break;
    }
  }

  while (residents_.size() >= kMaxLoaded) {
    if (!evict_lru_locked(model_id)) break;
  }

  ResidentModel resident;
  resident.id = model_id;
  resident.path = path;
  resident.options = cfg;
  LoadOptions load_cfg = cfg;
  lock.unlock();
  if (on_progress) on_progress(28, "Initializing GPU…");
  const bool loaded = load_resident_handle(path, load_cfg, resident.handle, error, on_progress);
  if (loaded && on_progress) on_progress(82, "Finalizing context…");
  lock.lock();
  if (!loaded) return false;
  resident.options = load_cfg;
  touch_locked(resident);
  residents_.push_back(std::move(resident));
  return activate_locked(model_id, error);
#else
  (void)model_id;
  (void)path;
  error = infer_unavailable_reason();
  return false;
#endif
}

bool InferenceService::activate(const std::string& model_id, std::string& error) {
  std::lock_guard lock(mutex_);
  return activate_locked(model_id, error);
}

void InferenceService::unload() {
  std::lock_guard lock(mutex_);
  clear_residents_locked();
  clear_infer_server_locked();
  active_id_.clear();
}

bool InferenceService::unload_model(const std::string& model_id) {
  std::lock_guard lock(mutex_);
  if (backend_ == InferBackend::InferServer && active_id_ == model_id) {
    clear_infer_server_locked();
    active_id_.clear();
    return true;
  }
  for (size_t i = 0; i < residents_.size(); ++i) {
    if (residents_[i].id != model_id) continue;
    if (active_id_ == model_id) {
      active_id_.clear();
      backend_ = InferBackend::None;
    }
    free_resident_locked(residents_[i]);
    residents_.erase(residents_.begin() + static_cast<std::ptrdiff_t>(i));
    return true;
  }
  return false;
}

void InferenceService::build_chat_prompt(const std::vector<ChatMessage>& messages,
                                         std::string& prompt,
                                         std::vector<std::string>& image_paths,
                                         void* model_handle, bool enable_thinking,
                                         bool use_simple_prompt) {
  prompt.clear();
  image_paths.clear();

#ifdef OMEGA_ENGINE_HAVE_INFER
  if (!use_simple_prompt && model_handle) {
    std::vector<omega_chat_turn_t> turns;
    turns.reserve(messages.size());
    for (const auto& m : messages) {
      if (m.role != "system" && m.role != "user" && m.role != "assistant") continue;
      for (const auto& p : m.images) image_paths.push_back(p);
      for (const auto& p : m.image_paths) image_paths.push_back(p);
      turns.push_back({m.role.c_str(), m.content.c_str()});
    }
    if (!turns.empty() && image_paths.empty()) {
      std::string buf(8192, '\0');
      for (;;) {
        const int rc = omega_format_chat_prompt(static_cast<omega_model_t*>(model_handle), turns.data(),
                                                turns.size(), enable_thinking ? 1 : 0, buf.data(), buf.size());
        if (rc >= 0) {
          prompt.assign(buf.data(), static_cast<size_t>(rc));
          return;
        }
        if (rc == OMEGA_ERR || rc == OMEGA_ERR_NOT_BUILT) {
          break;
        }
        const size_t need = static_cast<size_t>(-rc);
        if (need <= buf.size()) break;
        buf.resize(need, '\0');
      }
    }
  }
#endif

  prompt.clear();
  image_paths.clear();
  for (const auto& m : messages) {
    if (m.role == "system") {
      prompt += "System: ";
      prompt += m.content;
      prompt += '\n';
    } else if (m.role == "user") {
      prompt += "User: ";
      for (const auto& p : m.images) {
        prompt += k_media_marker;
        prompt += ' ';
        image_paths.push_back(p);
      }
      for (const auto& p : m.image_paths) {
        prompt += k_media_marker;
        prompt += ' ';
        image_paths.push_back(p);
      }
      prompt += m.content;
      prompt += '\n';
    } else if (m.role == "assistant") {
      prompt += "Assistant: ";
      prompt += m.content;
      prompt += '\n';
    }
  }
  prompt += "Assistant: ";
}

bool InferenceService::generate(const std::string& prompt, const SamplingOptions& sampling,
                                TokenCallback on_token_in, std::string& full_text,
                                std::string& error, GenerationStats* stats_out) {
  const SamplingOptions sp = default_sampling(sampling);
  if (stats_out && stats_out->prompt_tokens <= 0) {
    stats_out->prompt_tokens = estimate_text_tokens(prompt);
  }
  std::lock_guard lock(mutex_);
  if (backend_ == InferBackend::InferServer && server_) {
    return server_->generate(prompt, sp, on_token_in, full_text, error, stats_out);
  }
#ifdef OMEGA_ENGINE_HAVE_INFER
  void* handle = active_handle_locked();
  if (!handle) {
    error = "no model loaded";
    return false;
  }
  if (auto* r = find_resident_locked(active_id_)) touch_locked(*r);
  if (static_cast<int>(prompt.size()) < 512 * 1024) {
    const int prompt_n =
        omega_prompt_token_count(static_cast<omega_model_t*>(handle), prompt.c_str());
    if (stats_out && prompt_n > 0) stats_out->prompt_tokens = prompt_n;
    const int n_ctx = omega_model_context_size(static_cast<omega_model_t*>(handle));
    if (prompt_n <= 0) {
      error =
          "prompt tokenization failed for the loaded model (empty or unsupported text for this "
          "vocabulary)";
      return false;
    }
    if (n_ctx > 0 && prompt_n + sp.max_tokens + 32 >= n_ctx) {
      error = "prompt exceeds model context (prompt_tokens=" + std::to_string(prompt_n) +
              ", max_tokens=" + std::to_string(sp.max_tokens) +
              ", loaded_context=" + std::to_string(n_ctx) +
              ") — shorten the prompt or reduce max_tokens";
      return false;
    }
  }
  omega_gen_params_t gp{};
  gp.temperature = sp.temperature;
  gp.top_p = sp.top_p;
  gp.top_k = sp.top_k;
  gp.max_tokens = sp.max_tokens;
  if (sp.seed != 0) gp.seed = sp.seed;

  TokenState state;
  state.full_text = &full_text;
  state.cb = std::move(on_token_in);
  state.cancel = nullptr;
  state.stats = stats_out;
  full_text.clear();
  const int rc = omega_generate(static_cast<omega_model_t*>(handle), prompt.c_str(), &gp,
                                omega_engine_token_cb, &state);
  if (rc != OMEGA_OK) {
    if (rc == OMEGA_ERR_CTX) {
      const int prompt_n =
          omega_prompt_token_count(static_cast<omega_model_t*>(handle), prompt.c_str());
      const int n_ctx = omega_model_context_size(static_cast<omega_model_t*>(handle));
      if (prompt_n <= 0) {
        error =
            "prompt tokenization failed for the loaded model (empty or unsupported text for this "
            "vocabulary)";
      } else if (n_ctx > 0) {
        error = "generation context error (prompt_tokens=" + std::to_string(prompt_n) +
                ", max_tokens=" + std::to_string(sp.max_tokens) +
                ", loaded_context=" + std::to_string(n_ctx) +
                ") — prompt may be too long or batch decode failed";
      } else {
        error = "generation context error — try a smaller prompt or lower max_tokens";
      }
    } else {
      error = "omega_generate failed with code " + std::to_string(rc);
    }
    return false;
  }
  finalize_generation_stats(stats_out, full_text, state.max_index);
  return true;
#else
  (void)prompt;
  (void)sp;
  (void)on_token_in;
  (void)full_text;
  error = infer_unavailable_reason();
  return false;
#endif
}

bool InferenceService::chat(const std::vector<ChatMessage>& messages,
                             const SamplingOptions& sampling, TokenCallback on_token_in,
                             std::string& full_text, std::string& error, bool enable_thinking,
                             bool use_simple_prompt, GenerationStats* stats_out) {
  const SamplingOptions sp = default_sampling(sampling);
  if (stats_out && stats_out->prompt_tokens <= 0) {
    stats_out->prompt_tokens = estimate_messages_tokens(messages);
  }
  std::string prompt;
  std::vector<std::string> image_paths;
  {
    std::lock_guard lock(mutex_);
    if (backend_ == InferBackend::InferServer && server_) {
      return server_->chat(messages, sp, on_token_in, full_text, error, stats_out);
    }
    void* handle = active_handle_locked();
    if (!handle) {
      error = "no model loaded";
      return false;
    }
    build_chat_prompt(messages, prompt, image_paths, handle, enable_thinking, use_simple_prompt);
  }
  if (!image_paths.empty()) {
    return generate_vision(prompt, image_paths, sp, on_token_in, full_text, error);
  }
  return generate(prompt, sp, on_token_in, full_text, error, stats_out);
}

bool InferenceService::embed(const std::string& text, std::vector<float>& vector,
                             std::string& error) {
  std::lock_guard lock(mutex_);
  if (backend_ == InferBackend::InferServer && server_) {
    return server_->embed(text, vector, error);
  }
#ifdef OMEGA_ENGINE_HAVE_INFER
  void* handle = active_handle_locked();
  if (!handle) {
    error = "no model loaded";
    return false;
  }
  if (auto* r = find_resident_locked(active_id_)) touch_locked(*r);
  std::vector<float> buf(8192);
  int out_dim = 0;
  const int rc = omega_embed(static_cast<omega_model_t*>(handle), text.c_str(), buf.data(),
                             static_cast<int>(buf.size()), &out_dim);
  if (rc != OMEGA_OK || out_dim <= 0) {
    error = "omega_embed failed with code " + std::to_string(rc);
    return false;
  }
  if (out_dim > static_cast<int>(buf.size())) {
    error = "embedding dimension exceeds buffer";
    return false;
  }
  vector.assign(buf.begin(), buf.begin() + out_dim);
  return true;
#else
  (void)text;
  (void)vector;
  error = infer_unavailable_reason();
  return false;
#endif
}

bool InferenceService::generate_vision(const std::string& prompt,
                                       const std::vector<std::string>& image_paths,
                                       const SamplingOptions& sampling,
                                       TokenCallback on_token_in, std::string& full_text,
                                       std::string& error) {
  const SamplingOptions sp = default_sampling(sampling);
  std::lock_guard lock(mutex_);
  if (backend_ == InferBackend::InferServer) {
    error = "vision chat is not supported with MTP infer-server mode";
    return false;
  }
#ifdef OMEGA_ENGINE_HAVE_INFER
  void* handle = active_handle_locked();
  if (!handle) {
    error = "no model loaded";
    return false;
  }
  if (omega_model_has_vision(static_cast<omega_model_t*>(handle)) == 0) {
    error = "model does not support vision";
    return false;
  }
  if (auto* r = find_resident_locked(active_id_)) touch_locked(*r);
  omega_gen_params_t gp{};
  gp.temperature = sp.temperature;
  gp.top_p = sp.top_p;
  gp.top_k = sp.top_k;
  gp.max_tokens = sp.max_tokens;
  if (sp.seed != 0) gp.seed = sp.seed;
  std::vector<const char*> c_paths;
  c_paths.reserve(image_paths.size());
  for (const auto& p : image_paths) c_paths.push_back(p.c_str());
  TokenState state;
  state.full_text = &full_text;
  state.cb = std::move(on_token_in);
  full_text.clear();
  const int rc = omega_generate_vision(
      static_cast<omega_model_t*>(handle), prompt.c_str(),
      c_paths.empty() ? nullptr : c_paths.data(), static_cast<int>(c_paths.size()), &gp,
      omega_engine_token_cb, &state);
  if (rc != OMEGA_OK) {
    error = "omega_generate_vision failed with code " + std::to_string(rc);
    return false;
  }
  return true;
#else
  (void)prompt;
  (void)image_paths;
  (void)sp;
  (void)on_token_in;
  (void)full_text;
  error = infer_unavailable_reason();
  return false;
#endif
}

InferenceService::InferenceService() = default;

InferenceService::~InferenceService() {
  std::lock_guard lock(mutex_);
  clear_residents_locked();
  clear_infer_server_locked();
}

}  // namespace omega::engine
