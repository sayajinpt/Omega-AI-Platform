#pragma once

/**
 * Omega / llama.cpp extension — in-process weight tensor migration between backends.
 * Migrate layers without re-reading the GGUF from disk when only placement changes.
 */
#include "llama.h"

#ifdef __cplusplus
extern "C" {
#endif

#define LLAMA_MIGRATE_OK 0
#define LLAMA_MIGRATE_ERR -1
#define LLAMA_MIGRATE_ERR_NO_GPU -2

/** If set, only update bookkeeping when n_gpu_layers unchanged (KV handled externally). */
#define LLAMA_MIGRATE_FLAG_KV_ONLY 1

/**
 * Move model weight tensors to match a new n_gpu_layers count.
 * Caller must free and recreate llama_context after a successful migrate that changed placement.
 *
 * @param n_gpu_layers  Same semantics as llama_model_params.n_gpu_layers
 * @param flags         LLAMA_MIGRATE_FLAG_KV_ONLY when layout unchanged
 * @return LLAMA_MIGRATE_OK on success
 */
LLAMA_API int32_t llama_model_migrate_layers(
    struct llama_model * model,
    int32_t n_gpu_layers,
    uint32_t flags);

#ifdef __cplusplus
}
#endif
