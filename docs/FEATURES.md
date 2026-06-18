# Omega — Complete Feature Matrix

Omega is a **single-system local AI OS** (v2 native stack). Everything below runs inside one install — no Electron, no external inference daemons or agent services.

## Inference engine

| Feature | Status |
|---------|--------|
| GGUF model loader & registry | ✅ |
| In-process GPU inference (`omega-engine` / `libomega_infer`) | ✅ |
| Bundled llama-server worker (`OMEGA_INFER_BIN`) | ✅ |
| CPU/GPU discovery (CUDA, ROCm, Metal, Vulkan) | ✅ |
| Streaming token generation | ✅ |
| KV cache via model hot-swap | ✅ |
| Embeddings API | ✅ |
| Bundled Ollama for non-GGUF formats | ✅ |
| Optional EXL2 / ONNX sidecars (post-install) | ✅ |

## Model ecosystem

| Feature | Status |
|---------|--------|
| HuggingFace download + resume | ✅ |
| Model delete | ✅ |
| VRAM footprint estimate | ✅ |
| Benchmark (tokens/sec) | ✅ |
| In-app quantization (`llama-quantize`) | ✅ |
| Multi-model LRU (runtime) | ✅ |

## Omega Agent

| Feature | Status |
|---------|--------|
| Planner → Executor → Tools → Critic → Respond | ✅ |
| Structured tool calls (` ```tool` JSON ````) | ✅ |
| FTS + vector memory in planning | ✅ |
| Decision graph persistence | ✅ |
| Live step timeline + token stream | ✅ |
| Parent/child step graph in UI | ✅ |

## Unified memory

| Feature | Status |
|---------|--------|
| SQLite + FTS5 keyword search | ✅ |
| Vector embeddings + semantic search | ✅ |
| Facts / preferences / tasks / decisions | ✅ |
| Session message history | ✅ |
| Context buffer + auto-trim | ✅ |
| Decision graph viewer | ✅ |

## Tool runtime

| Feature | Status |
|---------|--------|
| Scoped filesystem (read/write/list) | ✅ |
| JavaScript sandbox | ✅ |
| Python sandbox (system Python) | ✅ |
| Shell (opt-in, workspace cwd) | ✅ |
| Web fetch (opt-in) | ✅ |
| Memory search tool | ✅ |
| Plugin modules (`~/.omega/plugins`) | ✅ |

## API server (localhost)

Runtime HTTP: **`127.0.0.1:9877`**. Shell HTTP: **`127.0.0.1:9878`**.

| Endpoint | Status |
|----------|--------|
| `GET /healthz` | ✅ |
| `GET /v1/runtime/info`, `/v1/runtime/status` | ✅ |
| `GET /v1/models`, `/v1/models/loaded` | ✅ |
| `POST /v1/chat/send`, `/v1/chat/stream/poll` | ✅ |
| `POST /v1/agent/run` | ✅ |
| `POST /v1/embed` | ✅ |
| `POST /v1/models/download` | ✅ |
| `POST /v1/models/benchmark` | ✅ |
| `DELETE /v1/models/delete` | ✅ |
| Agent + chat via `window.omega` HTTP bridge | ✅ |

## Chat attachments & rich media

| Feature | Status |
|---------|--------|
| Text messages + markdown | ✅ |
| Attach files / images in composer | ✅ |
| Show user attachments in bubbles | ✅ |
| Vision models (image → model) | ✅ |
| Assistant inline images (stream / tools) | ✅ |
| `omega-media://` preview protocol | ✅ |
| Mic record → attach audio | 🔲 |
| Paste image from clipboard | 🔲 |

See **[CHAT-AND-MEDIA.md](./CHAT-AND-MEDIA.md)** for SDK types, IPC, and storage layout.

## Omega Companion (floating widget)

| Feature | Status |
|---------|--------|
| Always-expanded square 3D panel (no collapse mode) | ✅ |
| Compute-trace overlay (KV, confidence, top-k, pipeline) | ✅ |
| Native GGUF metrics (`omega-engine` KV + logit peek) | ✅ |
| Estimated metrics on Ollama / sidecar / remote (labeled) | ✅ |
| Companion top bar (phase, show/hide, detach monitor) | ✅ |
| In-widget quick chat (💬) → **current / last-open main chat** | ✅ |
| Voice input in companion (STT when available in OS) | ✅ |
| TTS on replies when voice enabled in Settings | ✅ |
| Screen region capture (⧉) → save or send to chat | ✅ |
| Detached always-on-top monitor window | ✅ |
| Live token stream + avatar phase sync | ✅ |

The Companion is **not** Omega Office — it is a separate floating HUD for inference visibility and quick messaging while you work in chat or other pages.

## Desktop UI

| Screen | Status |
|--------|--------|
| First-run onboarding | ✅ |
| Multi-session chat + context meter | ✅ |
| Omega Companion (3D + compute trace + quick chat) | ✅ |
| Model Studio (download/bench/VRAM/delete) | ✅ |
| Agent + execution graph | ✅ |
| Memory + decision graph | ✅ |
| Tools + plugin manager | ✅ |
| Settings (permissions, context size) | ✅ |
| Debug console (events + token stream) | ✅ |

## Packaging (v2 native)

| Item | Status |
|------|--------|
| Native shell (`apps/shell`) — WebView2 / WKWebView / WebKitGTK | ✅ |
| NSIS installer (Windows) → `dist/native/` | ✅ |
| AppImage (Linux) / DMG (macOS) | ✅ |
| `scripts/build-runtime.mjs` — C++ `omega-runtime` | ✅ |
| `scripts/package-native-shell.mjs` | ✅ |
| Runtime + engine bundled under `dist/native/Omega/resources/` | ✅ |
