# Llama.cpp variants and inference binaries

## Production installers (recommended)

From the `Omega/` directory:

| Platform | Command |
|----------|---------|
| Windows | `build.bat` |
| Linux | `chmod +x build.sh && ./build.sh` |

Each run:

1. `npm install`
2. Interactive `node scripts/llama-setup.mjs --installer` — pick release tag, **prebuilt** vs **source**, and **one** GPU stack
3. `npm run build:win` or `npm run build:linux` — syncs source, fetches omega-infer for the locked variant, packages the app

State is stored in `.omega/llama-setup.json`. Source cache: `.omega/cache/llama.cpp-src/<tag>/`.

---

## Variant IDs

Build each variant **on its host OS** (no cross-compile).

| Variant ID | Label |
|------------|-------|
| `win-cuda` | Windows x64 + NVIDIA (CUDA) |
| `win-vulkan` | Windows x64 + Vulkan |
| `nvidia-vulkan-windows` | NVIDIA + Vulkan — Windows (same binaries as `win-vulkan`) |
| `linux-cuda` | Linux x64 + NVIDIA (CUDA) |
| `linux-vulkan` | Linux x64 + Vulkan |
| `nvidia-vulkan-linux` | NVIDIA + Vulkan — Linux (same binaries as `linux-vulkan`) |

---

## Setup without a full installer

```bash
cd Omega
npm install
npm run setup:llama
```

Non-interactive:

```bash
npm run setup:llama -- --yes --mode=binary --variant=linux-vulkan
```

Use in dev:

```bash
export OMEGA_LLAMA_VARIANT=linux-cuda   # bash
npm run dev
```

---

## Dev-only: rebuild one variant (no native packager)

```bash
node scripts/llama-build-variant.mjs win-cuda
node scripts/llama-build-variant.mjs linux-vulkan --prebuilt-only
```

| Flag | Effect |
|------|--------|
| `--prebuilt-only` | Skip source build of node-llama-cpp bindings |
| `--force` | Re-download omega-infer |
| `--safe` | Source build with `parallel=1` (slowest; stable on Windows CUDA) |

Source bindings only:

```bash
node scripts/build-llama-variant.mjs win-cuda
node scripts/build-llama-variant.mjs linux-vulkan --safe
```

---

## What `prebuild:win` / `prebuild:linux` do

Invoked automatically by `npm run build:win` / `build:linux`:

1. Read primary variant from `.omega/llama-setup.json`
2. `sync-llama-cpp` → runtime + node-llama-cpp
3. `fetch-infer-binaries` for that variant → `dist/bin/<variant>/`, then promote to `dist/bin/`
4. Prune duplicate variant subdirs (keeps installer under NSIS size limits)
5. `ensure-llama-backends` for the chosen GPU
6. `build-runtime` (C++ `omega-runtime` → `dist/runtime/`)

macOS uses `prebuild:mac` (sync + fetch + runtime; Metal via node-llama-cpp).
