/**
 * libomega_infer — in-process GGUF inference for omega-engine (llama.cpp backend).
 */
#ifndef OMEGA_INFER_H
#define OMEGA_INFER_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#  ifdef OMEGA_INFER_EXPORTS
#    define OMEGA_API __declspec(dllexport)
#  else
#    define OMEGA_API __declspec(dllimport)
#  endif
#else
#  define OMEGA_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define OMEGA_OK 0
#define OMEGA_ERR -1
#define OMEGA_ERR_NOT_BUILT -2
#define OMEGA_ERR_LOAD -3
#define OMEGA_ERR_CTX -4

#define OMEGA_DEV_CPU 0
#define OMEGA_DEV_GPU 1

typedef struct omega_model_t omega_model_t;

typedef struct omega_load_params_t {
    int n_ctx;
    int n_gpu_layers;
    int n_batch;
    int n_threads;
    int main_gpu;
    float tensor_split[8];
    int n_tensor_split;
    const char * quant_policy; /* optional: q4_0, q8_0, auto */
    const char * mmproj_path;  /* optional vision projector; auto-detected in model dir if null */
    /**
     * llama.cpp flash attention: -1 = auto, 0 = off, 1 = on.
     * Mirrors Omega Settings → Chat flash attention.
     */
    int flash_attn;
    /** Optional load progress (0.0–1.0). Return false to cancel. */
    bool (*progress_callback)(float progress, void * user_data);
    void * progress_callback_user_data;
} omega_load_params_t;

typedef struct omega_capabilities_t {
    int paging;          /* staged layer reload (omega_page_layers) */
    int paging_inflight; /* 1 = in-process tensor migrate + context recreate (no GGUF reload) */
    int layer_quant;     /* 1 = quant file swap on disk for same stem */
    int layer_quant_mixed; /* 1 = partial layer ranges + buft tiering (not true per-tensor requant) */
    int multi_context;   /* multiple omega_model_t handles */
    int vision;          /* 1 = llama.cpp mtmd multimodal (GGUF + mmproj) */
    int npu;             /* filled by runtime host */
} omega_capabilities_t;

typedef struct omega_gen_params_t {
    float temperature;
    float top_p;
    int top_k;
    int max_tokens;
    int seed;
} omega_gen_params_t;

/** Called once per generated token chunk (UTF-8, not necessarily null-terminated). */
typedef int (*omega_token_cb)(const char * text, int index, void * user);

typedef struct omega_chat_turn_t {
    const char * role;
    const char * content;
} omega_chat_turn_t;

/** Format chat messages with the model's GGUF template (enable_thinking for Qwen3, etc.). */
OMEGA_API int omega_format_chat_prompt(
    omega_model_t * model,
    const omega_chat_turn_t * turns,
    size_t n_turns,
    int enable_thinking,
    char * out,
    size_t out_cap);

/** 1 if library was built with llama.cpp linked. */
OMEGA_API int omega_infer_available(void);

/** 1 when this build can offload model layers to GPU (CUDA/Vulkan/Metal). */
OMEGA_API int omega_infer_gpu_offload_available(void);

/** Tear down GPU backends and re-init llama with CUDA hidden (CPU-only retry path). */
OMEGA_API int omega_infer_reinit_cpu_only(void);

OMEGA_API omega_capabilities_t omega_infer_capabilities(void);

/** Comma-separated GGML backends compiled into libomega_infer (e.g. "cuda,cpu"). */
OMEGA_API const char * omega_infer_compiled_backends(void);

OMEGA_API omega_model_t * omega_model_load(const char * path, const omega_load_params_t * params);

OMEGA_API void omega_model_free(omega_model_t * model);

/**
 * Move layers [from_layer, to_layer) toward CPU or GPU.
 * In-flight: llama_model_migrate_layers (tensor copy) + context recreate; mmap reload fallback.
 */
OMEGA_API int omega_page_layers(omega_model_t * model, int from_layer, int to_layer, int device);

/** Record quant policy for layer range; may reload when policy changes. */
OMEGA_API int omega_set_layer_quant(omega_model_t * model, int from_layer, int to_layer, const char * quant);

/** Token count for prompt text (same tokenizer as omega_generate). Returns -1 on error. */
OMEGA_API int omega_prompt_token_count(omega_model_t * model, const char * prompt);

/** Context window size (n_ctx) for the loaded model handle. Returns 0 on error. */
OMEGA_API int omega_model_context_size(omega_model_t * model);

OMEGA_API int omega_generate(
    omega_model_t * model,
    const char * prompt,
    const omega_gen_params_t * params,
    omega_token_cb cb,
    void * user
);

/**
 * Multimodal generation: prompt must contain mtmd_default_marker() ("<__media__>")
 * once per image, in order. image_paths are absolute filesystem paths.
 */
OMEGA_API int omega_generate_vision(
    omega_model_t * model,
    const char * prompt,
    const char * const * image_paths,
    int n_images,
    const omega_gen_params_t * params,
    omega_token_cb cb,
    void * user
);

/** Returns 1 if model has a loaded mtmd context (vision ready). */
OMEGA_API int omega_model_has_vision(const omega_model_t * model);

OMEGA_API int omega_embed(
    omega_model_t * model,
    const char * text,
    float * out,
    int out_cap,
    int * out_dim
);

#ifdef __cplusplus
}
#endif

#endif /* OMEGA_INFER_H */
