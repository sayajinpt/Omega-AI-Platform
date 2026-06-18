# In-process tensor migration (`llama_model_migrate_layers`)

Omega extends llama.cpp with an API to move model **weight tensors** between CPU and GPU buffer types **without re-reading the GGUF file**.

## API

```c
#include "llama_model_migrate.h"

// After changing desired GPU layer count:
int32_t rc = llama_model_migrate_layers(model, n_gpu_layers, 0);
// Then recreate context (weights stay in RAM):
ctx = llama_init_from_model(model, cparams);
```

### Flags

| Flag | Meaning |
|------|---------|
| `LLAMA_MIGRATE_FLAG_KV_ONLY` | Layout unchanged; no-op success |

### Return codes

| Code | Meaning |
|------|---------|
| `LLAMA_MIGRATE_OK` | Tensors updated (or nothing to do) |
| `LLAMA_MIGRATE_ERR` | Migration failed (caller may fall back to full reload) |
| `LLAMA_MIGRATE_ERR_NO_GPU` | GPU offload requested but unavailable |

## How it works

1. Update `model->params.n_gpu_layers`.
2. For each weight tensor (`blk.N.*`, embeddings, output):
   - Compute target buffer type via `llama_model::select_buft(layer)`.
   - If already on target buft, skip.
   - `ggml_backend_tensor_get` → host staging → alloc on target buft → `ggml_backend_tensor_set`.
   - Update `tensors_by_name` to point at the new tensor.
3. Caller frees `llama_context` and calls `llama_init_from_model` (graph rebuild only).

## `libomega_infer` integration

`omega_page_layers()`:

1. Clears KV cache.
2. Frees context.
3. Calls `llama_model_migrate_layers`.
4. Recreates context with `reload_context_only()` (no `llama_model_load_from_file`).
5. On failure → mmap reload fallback.

## Limitations

- Does not change quantization type in a single GGUF (use offline `llama-quantize --tensor-type`; see `MIXED-QUANT.md`).
- Repacked / extra buffer types may fail migration → full reload fallback.
- Old GPU/CPU tensor buffers are released when the model is freed (small leak per migrate until free).

## Build

Migration is compiled into the `llama` static library via `native/patches/llama_model_migrate.cpp`:

```powershell
npm run build:native
npm run build:runtime:native
```
