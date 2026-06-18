/**
 * In-process migration of llama model weights between CPU and GPU buffer types.
 */
#include "llama_model_migrate.h"

#include "llama-model.h"

#include "ggml.h"
#include "ggml-cpp.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"

#include <cctype>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

int parse_blk_layer(const char * name) {
    const char * p = strstr(name, "blk.");
    if (!p || !isdigit((unsigned char) p[4])) {
        return -1;
    }
    return atoi(p + 4);
}

bool tensor_on_buft(const ggml_tensor * t, ggml_backend_buffer_type_t buft) {
    return t && t->buffer && buft && ggml_backend_buffer_get_type(t->buffer) == buft;
}

struct buft_ctx {
    ggml_context_ptr ctx;
    ggml_backend_buffer_ptr buf;
};

buft_ctx * get_ctx_for_buft(std::unordered_map<ggml_backend_buffer_type_t, buft_ctx> & cache, ggml_backend_buffer_type_t buft) {
    auto it = cache.find(buft);
    if (it != cache.end()) {
        return &it->second;
    }
    ggml_init_params params{};
    params.mem_size = 64 * 1024 * 1024;
    params.no_alloc = true;
    buft_ctx entry;
    entry.ctx.reset(ggml_init(params));
    if (!entry.ctx) {
        return nullptr;
    }
    auto ins = cache.emplace(buft, std::move(entry));
    return &ins.first->second;
}

ggml_tensor * migrate_one(
    ggml_tensor * src,
    ggml_backend_buffer_type_t dst_buft,
    std::unordered_map<ggml_backend_buffer_type_t, buft_ctx> & buft_cache,
    std::vector<uint8_t> & staging
) {
    if (!src || !dst_buft || tensor_on_buft(src, dst_buft)) {
        return src;
    }

    const size_t nbytes = ggml_nbytes(src);
    if (nbytes == 0) {
        return src;
    }

    staging.resize(nbytes);
    ggml_backend_tensor_get(src, staging.data(), 0, nbytes);

    buft_ctx * bc = get_ctx_for_buft(buft_cache, dst_buft);
    if (!bc || !bc->ctx) {
        return nullptr;
    }

    ggml_tensor * dst = ggml_dup_tensor(bc->ctx.get(), src);
    if (!dst) {
        return nullptr;
    }

    if (!bc->buf) {
        bc->buf.reset(ggml_backend_alloc_ctx_tensors_from_buft(bc->ctx.get(), dst_buft));
    }
    if (!bc->buf) {
        return nullptr;
    }

    ggml_tallocr talloc = ggml_tallocr_new(bc->buf.get());
    if (ggml_tallocr_alloc(&talloc, dst) != GGML_STATUS_SUCCESS) {
        bc->buf.reset(ggml_backend_alloc_ctx_tensors_from_buft(bc->ctx.get(), dst_buft));
        if (!bc->buf) {
            return nullptr;
        }
        talloc = ggml_tallocr_new(bc->buf.get());
        if (ggml_tallocr_alloc(&talloc, dst) != GGML_STATUS_SUCCESS) {
            return nullptr;
        }
    }

    ggml_backend_tensor_set(dst, staging.data(), 0, nbytes);
    return dst;
}

} // namespace

int32_t llama_model_migrate_layers(llama_model * model, int32_t n_gpu_layers, uint32_t flags) {
    (void) model;
    (void) n_gpu_layers;
    (void) flags;
    // llama.cpp b9247: llama_model::params is protected — hot layer migration disabled until
    // we adopt a public upstream API. ACO can still tune context/batch via reload.
    return LLAMA_MIGRATE_ERR;

#if 0
    if (!model) {
        return LLAMA_MIGRATE_ERR;
    }

    const int32_t old_gpu = (int32_t) model->n_gpu_layers();
    if (n_gpu_layers == old_gpu) {
        return LLAMA_MIGRATE_OK;
    }

    if (!llama_supports_gpu_offload() && n_gpu_layers > 0) {
        return LLAMA_MIGRATE_ERR_NO_GPU;
    }

    model->params.n_gpu_layers = n_gpu_layers;

    std::unordered_map<ggml_backend_buffer_type_t, buft_ctx> buft_cache;
    std::vector<uint8_t> staging;
    int migrated = 0;
    int failed = 0;

    for (auto & entry : model->tensors_by_name) {
        const std::string & name = entry.first;
        ggml_tensor * tensor = entry.second;
        if (!tensor) {
            continue;
        }

        int il = parse_blk_layer(name.c_str());
        ggml_backend_buffer_type_t want = nullptr;

        if (il >= 0) {
            want = model->select_buft(il);
        } else if (name.find("token_embd") != std::string::npos) {
            want = model->select_buft(0);
        } else if (name.find("output_norm") != std::string::npos) {
            want = model->select_buft(0);
        } else if (name.find("output") != std::string::npos) {
            want = model->select_buft((int) model->hparams.n_layer);
        } else {
            continue;
        }

        if (!want || tensor_on_buft(tensor, want)) {
            continue;
        }

        ggml_tensor * moved = migrate_one(tensor, want, buft_cache, staging);
        if (moved && moved != tensor) {
            entry.second = moved;
            migrated++;
        } else if (!moved) {
            failed++;
        }
    }

    if (failed > 0 && migrated == 0) {
        model->params.n_gpu_layers = old_gpu;
        return LLAMA_MIGRATE_ERR;
    }

    return LLAMA_MIGRATE_OK;
#endif
}
