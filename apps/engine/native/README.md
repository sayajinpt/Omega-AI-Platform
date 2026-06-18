# libomega_infer

In-process GGUF inference for **omega-engine**, built on [llama.cpp](https://github.com/ggml-org/llama.cpp).

The Go **omega-runtime** was removed in Phase 14; this directory is the native C++ library only.

## Layout

```
native/
  include/omega_infer.h   # C API
  src/omega_infer.cpp     # Implementation
  CMakeLists.txt
  lib/                    # Built artifacts (omega_infer.dll / .lib)
  third_party/llama.cpp/  # Fetched by build script
```

## Build (Windows)

From repo root (auto-finds CMake inside Visual Studio via `vswhere`):

```powershell
npm run build:native
node scripts/build-engine.mjs
```

Scripts use `scripts/lib-vs-tools.ps1` to locate CMake and MSVC.

Override CMake: `$env:OMEGA_CMAKE = 'C:\path\to\cmake.exe'`

This will:

1. Clone `llama.cpp` into `third_party/llama.cpp` if missing
2. CMake-build `libomega_infer` with CUDA/CPU per llama.cpp defaults
3. Link into `omega-engine` via `apps/engine/CMakeLists.txt`

## Build manually

```powershell
cd apps/engine/native
cmake -B build -DOMEGA_HAVE_LLAMA_CPP=ON
cmake --build build --config Release
# copies to native/lib/

cd ..
cmake -B build
cmake --build build --config Release
```

## C API highlights

| Function | Purpose |
|----------|---------|
| `omega_infer_available()` | 1 when llama.cpp is linked |
| `omega_infer_capabilities()` | `paging`, `multi_context`, … |
| `omega_model_load` / `omega_model_free` | GGUF lifecycle |
| `omega_page_layers` | KV-clear + mmap reload; same layout = KV-only (weights stay mapped) |
| `omega_set_layer_quant` | Quant file swap + partial layer policy; true mixed dtypes → offline quant |
| `omega_generate` | Streaming completion |

## Subprocess fallback (MTP)

Speculative decoding (draft-mtp) uses bundled `omega-infer` / `llama-server` from `resources/bin`, spawned by `omega-engine` (`infer_server_backend.cpp`).

## Requirements

- CMake 3.20+
- C++20 compiler (MSVC 2022+ on Windows)
- Git (to clone llama.cpp)
- Optional: CUDA toolkit for GPU layers in llama.cpp
