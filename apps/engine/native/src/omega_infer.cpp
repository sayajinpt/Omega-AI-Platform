/**
 * libomega_infer implementation.
 * Built with -DOMEGA_HAVE_LLAMA_CPP=1 when llama.cpp is available via CMake.
 */
#include "omega_infer.h"
#include "omega_infer_internal.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <filesystem>
#include <string>
#include <vector>
#include <mutex>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
#  include "llama.h"
#  include "llama_model_migrate.h"
#  include "ggml-backend.h"
#endif

namespace fs = std::filesystem;

namespace {

std::once_flag g_backend_once;

static bool env_truthy(const char * name) {
    const char * v = std::getenv(name);
    if (!v || !v[0]) {
        return false;
    }
    return v[0] == '1' || v[0] == 'y' || v[0] == 'Y' || v[0] == 't' || v[0] == 'T';
}

void backend_init_once() {
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    ggml_set_abort_callback([](const char * msg) {
        if (msg && msg[0]) {
            std::fprintf(stderr, "libomega_infer fatal: %s\n", msg);
            std::fflush(stderr);
        }
    });
    // Avoid CUDA pinned host buffers for llama output/KV staging — crashes on some
    // driver + VRAM combos (ACCESS_VIOLATION during llama_context init on packaged installs).
    if (!std::getenv("GGML_CUDA_NO_PINNED")) {
#ifdef _WIN32
        _putenv("GGML_CUDA_NO_PINNED=1");
#else
        setenv("GGML_CUDA_NO_PINNED", "1", 0);
#endif
    }
    if (env_truthy("OMEGA_INFER_CPU_ONLY")) {
#ifdef _WIN32
        _putenv("CUDA_VISIBLE_DEVICES=-1");
#else
        setenv("CUDA_VISIBLE_DEVICES", "-1", 1);
#endif
    }
    llama_backend_init();
#endif
}

static omega_load_params_t default_load(const omega_load_params_t * p) {
    omega_load_params_t out{};
    if (p) {
        out = *p;
    }
    if (out.n_ctx <= 0) out.n_ctx = 8192;
    if (out.n_batch <= 0) out.n_batch = 2048;
    if (out.n_gpu_layers < 0) out.n_gpu_layers = 999;
    if (out.n_threads <= 0) out.n_threads = 0;
    if (out.flash_attn < -1 || out.flash_attn > 1) {
        out.flash_attn = -1;
    }
    return out;
}

static std::string lower(std::string s) {
    for (char & c : s) {
        c = (char) std::tolower((unsigned char) c);
    }
    return s;
}

/** Strip trailing -Q4_K_M style quant suffix from filename stem. */
static std::string model_stem(const std::string & filename) {
    std::string stem = fs::path(filename).stem().string();
    const char * tags[] = {"-iq", "-q", "-f16", "-f32", "-bf16"};
    for (const char * tag : tags) {
        auto pos = stem.rfind(tag);
        if (pos != std::string::npos && pos > 4) {
            return stem.substr(0, pos);
        }
    }
    return stem;
}

/** Find another GGUF in the same folder with matching stem + quant token. */
static std::string find_quant_variant(const std::string & path, const std::string & quant) {
    if (quant.empty()) {
        return {};
    }
    fs::path p(path);
    if (!fs::exists(p.parent_path())) {
        return {};
    }
    const std::string stem = model_stem(p.filename().string());
    const std::string q = lower(quant);
    std::string best;
    for (const auto & entry : fs::directory_iterator(p.parent_path())) {
        if (!entry.is_regular_file()) {
            continue;
        }
        if (entry.path().extension() != ".gguf") {
            continue;
        }
        const std::string name = entry.path().filename().string();
        const std::string name_l = lower(name);
        if (name_l.find(q) == std::string::npos) {
            continue;
        }
        if (model_stem(name) != stem) {
            continue;
        }
        if (fs::equivalent(entry.path(), p)) {
            continue;
        }
        best = entry.path().string();
        break;
    }
    return best;
}

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
static std::string token_to_piece(const llama_vocab * vocab, llama_token token) {
    std::string piece;
    piece.resize(256);
    int32_t n = llama_token_to_piece(vocab, token, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
    if (n < 0) {
        piece.resize(static_cast<size_t>(-n));
        n = llama_token_to_piece(vocab, token, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
        if (n < 0) {
            return {};
        }
    }
    if (n <= 0) {
        return {};
    }
    piece.resize(static_cast<size_t>(n));
    return piece;
}
#endif

} // namespace

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP

static void apply_flash_attn(llama_context_params & cparams, const omega_load_params_t & load) {
    if (load.flash_attn == 0) {
        cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    } else if (load.flash_attn == 1) {
        cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_ENABLED;
    } else {
        cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
    }
}

/** Weights may stay on GPU; keep KV / hybrid recurrent state on CPU for 6–8 GB cards. */
static void apply_context_load_policy(llama_context_params & cparams, const omega_load_params_t & load) {
    apply_flash_attn(cparams, load);
    cparams.offload_kqv = false;
    cparams.op_offload = false;
}

/** Per-layer host placement for layers >= cutoff (in-flight paging path). */
static void rebuild_buft_overrides(omega_model_impl * m) {
    m->buft_overrides.clear();
    m->buft_pattern_buf.clear();
    if (m->gpu_layer_cutoff < 0) {
        return;
    }
    const ggml_backend_buffer_type_t cpu = ggml_backend_cpu_buffer_type();
    const int max_layer = 128;
    for (int i = m->gpu_layer_cutoff; i < max_layer; ++i) {
        const size_t off = m->buft_pattern_buf.size();
        m->buft_pattern_buf.resize(off + 32, '\0');
        snprintf(m->buft_pattern_buf.data() + off, 32, "blk.%d.", i);
        m->buft_overrides.push_back({ m->buft_pattern_buf.data() + off, cpu });
    }
    m->buft_overrides.push_back({ nullptr, nullptr });
}

void omega_impl_clear_kv(omega_model_impl * m) {
    if (!m || !m->ctx) {
        return;
    }
    llama_memory_t mem = llama_get_memory(m->ctx);
    if (mem) {
        llama_memory_clear(mem, true);
    }
}

/** Recreate context only — model weights stay mapped in RAM (unload-free paging step). */
static bool reload_context_only(omega_model_impl * m) {
    if (!m || !m->model) {
        return false;
    }
    if (m->ctx) {
        omega_impl_clear_kv(m);
        llama_free(m->ctx);
        m->ctx = nullptr;
    }
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) m->load.n_ctx;
    cparams.n_batch = (uint32_t) m->load.n_batch;
    cparams.n_threads = m->load.n_threads > 0 ? (uint32_t) m->load.n_threads : 0;
    cparams.n_threads_batch = cparams.n_threads;
    apply_context_load_policy(cparams, m->load);
    m->ctx = llama_init_from_model(m->model, cparams);
    return m->ctx != nullptr;
}

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
static bool llama_load_progress(float progress, void * user_data) {
    const auto * cb = static_cast<const omega_load_params_t *>(user_data);
    if (cb && cb->progress_callback) {
        return cb->progress_callback(progress, cb->progress_callback_user_data);
    }
    return true;
}
#endif

static bool reload_model(omega_model_impl * m, bool kv_only_teardown, bool keep_weights = false) {
    if (!m) {
        return false;
    }
    if (m->ctx) {
        if (kv_only_teardown) {
            omega_impl_clear_kv(m);
        }
        llama_free(m->ctx);
        m->ctx = nullptr;
    }
    if (keep_weights && m->model) {
        return reload_context_only(m);
    }
    if (m->model) {
        omega_impl_teardown_vision(m);
        llama_model_free(m->model);
        m->model = nullptr;
    }

    rebuild_buft_overrides(m);

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = m->load.n_gpu_layers >= 999 ? 999 : m->load.n_gpu_layers;
    mparams.use_mmap = true;
    if (m->load.n_gpu_layers == 0) {
        // llama.cpp: main_gpu=-1 clears model.devices so context init stays CPU-only.
        mparams.no_host = true;
        mparams.main_gpu = -1;
    } else {
        mparams.main_gpu = m->load.main_gpu;
    }
    if (m->load.progress_callback) {
        mparams.progress_callback = llama_load_progress;
        mparams.progress_callback_user_data = &m->load;
    }
    if (!m->buft_overrides.empty()) {
        mparams.tensor_buft_overrides = m->buft_overrides.data();
    }

    m->model = llama_model_load_from_file(m->path.c_str(), mparams);
    if (!m->model) {
        return false;
    }

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = (uint32_t) m->load.n_ctx;
    cparams.n_batch = (uint32_t) m->load.n_batch;
    cparams.n_threads = m->load.n_threads > 0 ? (uint32_t) m->load.n_threads : 0;
    cparams.n_threads_batch = cparams.n_threads;
    apply_context_load_policy(cparams, m->load);

    std::fprintf(stderr,
                 "libomega_infer: llama_init_from_model gpu_layers=%d main_gpu=%d n_ctx=%d "
                 "offload_kqv=%d embeddings=%d flash_attn=%d\n",
                 m->load.n_gpu_layers, mparams.main_gpu, m->load.n_ctx,
                 cparams.offload_kqv ? 1 : 0, cparams.embeddings ? 1 : 0, m->load.flash_attn);
    std::fflush(stderr);

    m->ctx = llama_init_from_model(m->model, cparams);
    if (!m->ctx) {
        std::fprintf(stderr, "libomega_infer: llama_init_from_model returned null\n");
        std::fflush(stderr);
    }
    return m->ctx != nullptr;
}

bool omega_impl_reload_context(omega_model_impl * m) {
    return reload_context_only(m);
}

static std::vector<llama_token> tokenize_prompt(llama_model * model, const std::string & prompt, bool add_bos) {
    const llama_vocab * vocab = llama_model_get_vocab(model);
    const int n_max = (int) prompt.size() + 8;
    std::vector<llama_token> tokens((size_t) n_max);
    int n = llama_tokenize(vocab, prompt.c_str(), (int32_t) prompt.size(), tokens.data(), (int32_t) tokens.size(), add_bos, false);
    if (n < 0) {
        tokens.resize((size_t) (-n));
        n = llama_tokenize(vocab, prompt.c_str(), (int32_t) prompt.size(), tokens.data(), (int32_t) tokens.size(), add_bos, false);
    }
  tokens.resize((size_t) n);
  return tokens;
}

/** Prefill prompt tokens in chunks of n_batch (required when prompt > n_batch). */
static bool decode_prompt_in_batches(omega_model_impl * m, const std::vector<llama_token> & tokens) {
  if (tokens.empty()) {
    return true;
  }
  const int32_t ctx_batch = (int32_t) llama_n_batch(m->ctx);
  const int32_t n_batch = std::max(32, std::min((int32_t) m->load.n_batch, ctx_batch > 0 ? ctx_batch : (int32_t) m->load.n_batch));
  const int32_t n_tokens = (int32_t) tokens.size();
  for (int32_t i = 0; i < n_tokens; i += n_batch) {
    const int32_t chunk = std::min(n_batch, n_tokens - i);
    llama_batch batch = llama_batch_get_one(const_cast<llama_token *>(tokens.data() + i), chunk);
    if (llama_decode(m->ctx, batch) != 0) {
      return false;
    }
  }
  return true;
}

#endif /* OMEGA_HAVE_LLAMA_CPP */

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP && (!defined(OMEGA_HAVE_MTMD) || !OMEGA_HAVE_MTMD)
int omega_impl_setup_vision(omega_model_impl * m, const char * mmproj_override) {
    if (m && mmproj_override && mmproj_override[0]) {
        m->mmproj_path = mmproj_override;
    }
    return 0;
}
void omega_impl_teardown_vision(omega_model_impl * m) {
    if (m) {
        m->mmproj_path.clear();
    }
}
#endif

extern "C" {

int omega_infer_available(void) {
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    return 1;
#else
    return 0;
#endif
}

int omega_infer_gpu_offload_available(void) {
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    std::call_once(g_backend_once, backend_init_once);
    return llama_supports_gpu_offload() ? 1 : 0;
#else
    return 0;
#endif
}

const char * omega_infer_compiled_backends(void) {
#if defined(GGML_USE_CUDA)
    return "cuda,cpu";
#elif defined(GGML_USE_VULKAN)
    return "vulkan,cpu";
#elif defined(GGML_USE_METAL)
    return "metal,cpu";
#elif defined(GGML_USE_SYCL)
    return "sycl,cpu";
#elif defined(GGML_USE_HIP)
    return "hip,cpu";
#else
    return "cpu";
#endif
}

omega_capabilities_t omega_infer_capabilities(void) {
    omega_capabilities_t c{};
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    c.paging = 1;
    c.paging_inflight = 1;
    c.layer_quant = 1;
    c.layer_quant_mixed = 1;
    c.multi_context = 1;
#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
    c.vision = 1;
#endif
#else
    c.paging = 0;
    c.paging_inflight = 0;
    c.layer_quant = 0;
    c.layer_quant_mixed = 0;
    c.multi_context = 0;
#endif
    return c;
}

omega_model_t * omega_model_load_impl(const char * path, const omega_load_params_t * params) {
    if (!path || !path[0]) {
        return nullptr;
    }
    std::call_once(g_backend_once, backend_init_once);

    auto * m = new omega_model_impl();
    m->path = path;
    m->original_path = path;
    m->load = default_load(params);
    if (params && params->quant_policy) {
        m->quant_policy = params->quant_policy;
    }
    if (params && params->mmproj_path) {
        m->mmproj_path = params->mmproj_path;
    }

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    if (!reload_model(m, false)) {
        delete m;
        return nullptr;
    }
    return reinterpret_cast<omega_model_t *>(m);
#else
    (void) m;
    return nullptr;
#endif
}

#if defined(_WIN32) && defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
static const char * seh_code_name(unsigned long code) {
    switch (code) {
        case 0xC0000005u: return "ACCESS_VIOLATION";
        case 0xC00000FDu: return "STACK_OVERFLOW";
        case 0xC0000017u: return "NO_MEMORY";
        case 0xC000001Du: return "ILLEGAL_INSTRUCTION";
        default: return "UNKNOWN";
    }
}

/** Catch access violations during llama context init so omega-engine stays alive for retries. */
static omega_model_t * omega_model_load_guarded(const char * path,
                                                 const omega_load_params_t * params) {
    omega_model_t * result = nullptr;
    __try {
        result = omega_model_load_impl(path, params);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        const unsigned long code = static_cast<unsigned long>(GetExceptionCode());
        std::fprintf(stderr, "libomega_infer: SEH %s (0x%08lx) during model load\n",
                     seh_code_name(code), code);
        std::fflush(stderr);
        result = nullptr;
    }
    return result;
}
#endif

int omega_infer_reinit_cpu_only(void) {
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    llama_backend_free();
#ifdef _WIN32
    _putenv("CUDA_VISIBLE_DEVICES=-1");
#else
    setenv("CUDA_VISIBLE_DEVICES", "-1", 1);
#endif
    llama_backend_init();
    return OMEGA_OK;
#else
    return OMEGA_ERR_NOT_BUILT;
#endif
}

omega_model_t * omega_model_load(const char * path, const omega_load_params_t * params) {
#if defined(_WIN32) && defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    const omega_load_params_t cfg = default_load(params);
    omega_model_t * result = omega_model_load_guarded(path, params);
    if (!result) {
        std::fprintf(stderr,
                     "libomega_infer: model load failed or crashed (gpu_layers=%d n_ctx=%d flash_attn=%d)\n",
                     cfg.n_gpu_layers, cfg.n_ctx, cfg.flash_attn);
        std::fflush(stderr);
    }
    return result;
#else
    return omega_model_load_impl(path, params);
#endif
}

void omega_model_free(omega_model_t * model) {
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m) {
        return;
    }
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    omega_impl_teardown_vision(m);
    if (m->ctx) {
        llama_free(m->ctx);
    }
    if (m->model) {
        llama_model_free(m->model);
    }
#endif
    delete m;
}

int omega_page_layers(omega_model_t * model, int from_layer, int to_layer, int device) {
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m) {
        return OMEGA_ERR;
    }
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    return OMEGA_ERR_NOT_BUILT;
#else
    const bool had_ctx = m->ctx != nullptr;
    const int prev_gpu = m->load.n_gpu_layers;
    const int prev_cut = m->gpu_layer_cutoff;

    int new_gpu = prev_gpu;
    int new_cut = prev_cut;
    if (device == OMEGA_DEV_CPU) {
        new_gpu = to_layer > 0 ? from_layer : 0;
        new_cut = from_layer > 0 ? from_layer : 0;
    } else {
        new_gpu = to_layer > 0 ? to_layer : m->load.n_gpu_layers;
        new_cut = to_layer > 0 ? to_layer : -1;
    }

    if (had_ctx && new_gpu == prev_gpu && new_cut == prev_cut) {
        omega_impl_clear_kv(m);
        m->used_inflight_paging = true;
        m->n_paging_ops++;
        return OMEGA_OK;
    }

    m->load.n_gpu_layers = new_gpu;
    m->gpu_layer_cutoff = new_cut;

    if (m->ctx) {
        omega_impl_clear_kv(m);
        llama_free(m->ctx);
        m->ctx = nullptr;
    }

    if (m->model && new_gpu != prev_gpu) {
        const int32_t mr = llama_model_migrate_layers(m->model, new_gpu, 0);
        if (mr == LLAMA_MIGRATE_OK) {
            rebuild_buft_overrides(m);
            if (reload_context_only(m)) {
                m->used_inflight_paging = true;
                m->n_paging_ops++;
                return OMEGA_OK;
            }
        }
    }

    if (!reload_model(m, had_ctx, false)) {
        return OMEGA_ERR_LOAD;
    }
    if (had_ctx) {
        m->used_inflight_paging = true;
    }
    m->n_paging_ops++;
    return OMEGA_OK;
#endif
}

int omega_set_layer_quant(omega_model_t * model, int from_layer, int to_layer, const char * quant) {
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !quant) {
        return OMEGA_ERR;
    }
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    return OMEGA_ERR_NOT_BUILT;
#else
    const bool partial = (from_layer > 0 || to_layer > 0);
    m->quant_policy = quant;
    if (partial) {
        LayerQuantRange r{};
        r.from_layer = from_layer;
        r.to_layer = to_layer > 0 ? to_layer : from_layer;
        r.quant = quant;
        m->layer_quants.push_back(r);
        m->used_mixed_quant = true;
        if (to_layer > 0) {
            m->gpu_layer_cutoff = to_layer;
        }
    }

    const bool had_ctx = m->ctx != nullptr;
    const std::string alt = find_quant_variant(m->path, quant);
    if (!alt.empty()) {
        m->path = alt;
        if (!reload_model(m, had_ctx)) {
            m->path = m->original_path;
            return OMEGA_ERR_LOAD;
        }
        return OMEGA_OK;
    }

    if (partial && !reload_model(m, had_ctx)) {
        return OMEGA_ERR_LOAD;
    }
    return OMEGA_OK;
#endif
}

int omega_prompt_token_count(omega_model_t * model, const char * prompt) {
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    (void) model;
    (void) prompt;
    return OMEGA_ERR_NOT_BUILT;
#else
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !m->model || !prompt) {
        return OMEGA_ERR;
    }
    const auto tokens = tokenize_prompt(m->model, prompt, true);
    if (tokens.empty()) {
        return OMEGA_ERR_CTX;
    }
    return static_cast<int>(tokens.size());
#endif
}

int omega_model_context_size(omega_model_t * model) {
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    (void) model;
    return 0;
#else
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !m->ctx) {
        return 0;
    }
    return static_cast<int>(llama_n_ctx(m->ctx));
#endif
}

int omega_generate(
    omega_model_t * model,
    const char * prompt,
    const omega_gen_params_t * params,
    omega_token_cb cb,
    void * user
) {
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    (void) model;
    (void) prompt;
    (void) params;
    (void) cb;
    (void) user;
    return OMEGA_ERR_NOT_BUILT;
#else
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !m->ctx || !m->model || !prompt) {
        return OMEGA_ERR;
    }

    omega_impl_clear_kv(m);
    llama_set_embeddings(m->ctx, false);

    omega_gen_params_t gp{};
    if (params) {
        gp = *params;
    }
    if (gp.temperature <= 0.f) {
        gp.temperature = 0.8f;
    }
    if (gp.top_p <= 0.f) {
        gp.top_p = 0.95f;
    }
    if (gp.top_k <= 0) {
        gp.top_k = 40;
    }
    if (gp.max_tokens <= 0) {
        gp.max_tokens = 512;
    }

    auto tokens = tokenize_prompt(m->model, prompt, true);
    if (tokens.empty()) {
        return OMEGA_ERR_CTX;
    }

    const int32_t n_ctx = llama_n_ctx(m->ctx);
    const int32_t slack = 32;
    if (n_ctx > 0 && static_cast<int32_t>(tokens.size()) + gp.max_tokens + slack > n_ctx) {
        return OMEGA_ERR_CTX;
    }
    if (n_ctx > 0 && static_cast<int32_t>(tokens.size()) >= n_ctx - slack) {
        return OMEGA_ERR_CTX;
    }

    if (!decode_prompt_in_batches(m, tokens)) {
        return OMEGA_ERR_CTX;
    }

    const llama_vocab * vocab = llama_model_get_vocab(m->model);
    auto sparams = llama_sampler_chain_default_params();
    llama_sampler * smpl = llama_sampler_chain_init(sparams);
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(gp.top_k));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(gp.top_p, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(gp.temperature));
    llama_sampler_chain_add(smpl, llama_sampler_init_dist(gp.seed >= 0 ? (uint32_t) gp.seed : LLAMA_DEFAULT_SEED));

    int n_out = 0;
    for (int i = 0; i < gp.max_tokens; ++i) {
        llama_token next = llama_sampler_sample(smpl, m->ctx, -1);
        llama_sampler_accept(smpl, next);

        if (llama_vocab_is_eog(vocab, next)) {
            break;
        }

        const std::string token_text = token_to_piece(vocab, next);
        if (!token_text.empty() && cb) {
            if (cb(token_text.c_str(), n_out, user) != 0) {
                break;
            }
        }
        n_out++;

        llama_batch next_batch = llama_batch_get_one(&next, 1);
        if (llama_decode(m->ctx, next_batch) != 0) {
            break;
        }
    }

    llama_sampler_free(smpl);
    return OMEGA_OK;
#endif
}

int omega_embed(
    omega_model_t * model,
    const char * text,
    float * out,
    int out_cap,
    int * out_dim
) {
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
    (void) model;
    (void) text;
    (void) out;
    (void) out_cap;
    (void) out_dim;
    return OMEGA_ERR_NOT_BUILT;
#else
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !m->ctx || !m->model || !text || !out || !out_dim) {
        return OMEGA_ERR;
    }

    omega_impl_clear_kv(m);
    llama_set_embeddings(m->ctx, true);

    auto tokens = tokenize_prompt(m->model, text, true);
    if (tokens.empty()) {
        llama_set_embeddings(m->ctx, false);
        return OMEGA_ERR_CTX;
    }

    if (!decode_prompt_in_batches(m, tokens)) {
        llama_set_embeddings(m->ctx, false);
        omega_impl_clear_kv(m);
        return OMEGA_ERR_CTX;
    }

    const float * emb = llama_get_embeddings(m->ctx);
    if (!emb) {
        emb = llama_get_embeddings_ith(m->ctx, -1);
    }
    if (!emb) {
        llama_set_embeddings(m->ctx, false);
        omega_impl_clear_kv(m);
        return OMEGA_ERR;
    }

    const int32_t n_embd = llama_model_n_embd(m->model);
    if (n_embd <= 0 || n_embd > out_cap) {
        *out_dim = n_embd;
        llama_set_embeddings(m->ctx, false);
        omega_impl_clear_kv(m);
        return OMEGA_ERR;
    }

    for (int32_t i = 0; i < n_embd; ++i) {
        out[i] = emb[i];
    }
    *out_dim = n_embd;
    llama_set_embeddings(m->ctx, false);
    omega_impl_clear_kv(m);
    return OMEGA_OK;
#endif
}

#if !defined(OMEGA_HAVE_MTMD) || !OMEGA_HAVE_MTMD
int omega_model_has_vision(const omega_model_t * model) {
    (void) model;
    return 0;
}
int omega_generate_vision(
    omega_model_t * model,
    const char * prompt,
    const char * const * image_paths,
    int n_images,
    const omega_gen_params_t * params,
    omega_token_cb cb,
    void * user
) {
    (void) model;
    (void) prompt;
    (void) image_paths;
    (void) n_images;
    (void) params;
    (void) cb;
    (void) user;
    return OMEGA_ERR_NOT_BUILT;
}
#endif

} // extern "C"
