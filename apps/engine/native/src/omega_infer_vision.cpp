/**
 * llama.cpp mtmd vision path for libomega_infer.
 */
#include "omega_infer.h"
#include "omega_infer_internal.h"

#include <cctype>
#include <filesystem>
#include <string>
#include <vector>

#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
#  include "mtmd.h"
#  include "mtmd-helper.h"
#endif

namespace fs = std::filesystem;

namespace {

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP

static std::string model_stem_vision(const std::string & filename) {
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

std::string find_mmproj_near(const std::string & gguf_path) {
    fs::path p(gguf_path);
    if (!fs::exists(p.parent_path())) {
        return {};
    }
    const std::string stem = model_stem_vision(p.filename().string());
    for (const auto & entry : fs::directory_iterator(p.parent_path())) {
        if (!entry.is_regular_file() || entry.path().extension() != ".gguf") {
            continue;
        }
        const std::string name = entry.path().filename().string();
        std::string lower = name;
        for (char & c : lower) {
            c = (char) std::tolower((unsigned char) c);
        }
        if (lower.find("mmproj") == std::string::npos &&
            lower.find("clip") == std::string::npos &&
            lower.find("-vision") == std::string::npos) {
            continue;
        }
        if (fs::equivalent(entry.path(), p)) {
            continue;
        }
        if (!stem.empty()) {
            const std::string proj_stem = model_stem_vision(name);
            if (proj_stem.find(stem) == std::string::npos && stem.find(proj_stem) == std::string::npos) {
                continue;
            }
        }
        return entry.path().string();
    }
    return {};
}

#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD

bool init_mtmd(omega_model_impl * m) {
    if (!m || !m->model || m->mmproj_path.empty()) {
        return false;
    }
    if (m->mctx) {
        mtmd_free(m->mctx);
        m->mctx = nullptr;
    }
    mtmd_context_params mparams = mtmd_context_params_default();
    mparams.use_gpu = m->load.n_gpu_layers > 0;
    mparams.n_threads = m->load.n_threads > 0 ? m->load.n_threads : 4;
    mparams.warmup = false;
    m->mctx = mtmd_init_from_file(m->mmproj_path.c_str(), m->model, mparams);
    return m->mctx != nullptr && mtmd_support_vision(m->mctx);
}

#endif /* OMEGA_HAVE_MTMD */

#endif /* OMEGA_HAVE_LLAMA_CPP */

} // namespace

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP

int omega_impl_setup_vision(omega_model_impl * m, const char * mmproj_override) {
    if (!m || !m->model) {
        return 0;
    }
    if (mmproj_override && mmproj_override[0]) {
        m->mmproj_path = mmproj_override;
    } else if (m->mmproj_path.empty()) {
        m->mmproj_path = find_mmproj_near(m->path);
    }
    return m->mmproj_path.empty() ? 0 : 1;
}

void omega_impl_teardown_vision(omega_model_impl * m) {
    if (!m) {
        return;
    }
#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
    if (m->mctx) {
        mtmd_free(m->mctx);
        m->mctx = nullptr;
    }
#endif
    m->mmproj_path.clear();
}

#endif

extern "C" {

int omega_model_has_vision(const omega_model_t * model) {
#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
    const auto * m = reinterpret_cast<const omega_model_impl *>(model);
    if (m && m->mctx && mtmd_support_vision(m->mctx)) {
        return 1;
    }
    if (m && !m->mmproj_path.empty()) {
        return 1;
    }
    return 0;
#else
    (void) model;
    return 0;
#endif
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
#if !defined(OMEGA_HAVE_MTMD) || !OMEGA_HAVE_MTMD
    (void) model;
    (void) prompt;
    (void) image_paths;
    (void) n_images;
    (void) params;
    (void) cb;
    (void) user;
    return OMEGA_ERR_NOT_BUILT;
#else
    auto * m = reinterpret_cast<omega_model_impl *>(model);
    if (!m || !m->ctx || !m->model || !prompt) {
        return OMEGA_ERR;
    }
    if (!m->mctx && !m->mmproj_path.empty()) {
        if (!init_mtmd(m)) {
            return OMEGA_ERR_CTX;
        }
    }
    if (!m->mctx || !mtmd_support_vision(m->mctx)) {
        return OMEGA_ERR_CTX;
    }
    if (n_images > 0 && !image_paths) {
        return OMEGA_ERR;
    }

    omega_impl_clear_kv(m);
    llama_set_embeddings(m->ctx, false);

    std::vector<mtmd_bitmap *> bitmaps;
    std::vector<mtmd_helper_video *> videos;
    bitmaps.reserve((size_t) n_images);
    videos.reserve((size_t) n_images);
    for (int i = 0; i < n_images; ++i) {
        const mtmd_helper_bitmap_wrapper wrapped =
            mtmd_helper_bitmap_init_from_file(m->mctx, image_paths[i], false);
        if (!wrapped.bitmap) {
            for (mtmd_bitmap * b : bitmaps) {
                mtmd_bitmap_free(b);
            }
            for (mtmd_helper_video * v : videos) {
                mtmd_helper_video_free(v);
            }
            return OMEGA_ERR_CTX;
        }
        bitmaps.push_back(wrapped.bitmap);
        if (wrapped.video_ctx) {
            videos.push_back(wrapped.video_ctx);
        }
    }

    mtmd_input_chunks * chunks = mtmd_input_chunks_init();
    mtmd_input_text text_in{ prompt, true, true };
    const int32_t tok_rc = mtmd_tokenize(
        m->mctx, chunks, &text_in,
        n_images > 0 ? const_cast<const mtmd_bitmap **>(bitmaps.data()) : nullptr,
        (size_t) n_images);
    for (mtmd_bitmap * b : bitmaps) {
        mtmd_bitmap_free(b);
    }
    bitmaps.clear();
    if (tok_rc != 0) {
        for (mtmd_helper_video * v : videos) {
            mtmd_helper_video_free(v);
        }
        mtmd_input_chunks_free(chunks);
        return OMEGA_ERR_CTX;
    }

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

    llama_pos n_past = 0;
    const int32_t n_batch = m->load.n_batch > 0 ? m->load.n_batch : 512;
    const int32_t eval_rc = mtmd_helper_eval_chunks(
        m->mctx, m->ctx, chunks, n_past, 0, n_batch, true, &n_past);
    mtmd_input_chunks_free(chunks);
    for (mtmd_helper_video * v : videos) {
        mtmd_helper_video_free(v);
    }
    if (eval_rc != 0) {
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

        std::string piece;
        piece.resize(256);
        int32_t n = llama_token_to_piece(vocab, next, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
        if (n < 0) {
            piece.resize(static_cast<size_t>(-n));
            n = llama_token_to_piece(vocab, next, piece.data(), static_cast<int32_t>(piece.size()), 0, true);
        }
        if (n > 0 && cb) {
            piece.resize(static_cast<size_t>(n));
            if (cb(piece.c_str(), n_out, user) != 0) {
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

} // extern "C"
