# Omega v2 — native desktop stack

Omega **v2** (runtime version **2.0.0**) is the current shipping architecture: a **native desktop shell** + **C++ runtime** + **React UI**. There is **no Electron** and **no Node.js at runtime**.

Use this doc as the map when older notes still mention Electron, port `9876`, or a Go `omega-runtime`.

## What changed from v1

| v1 (legacy) | v2 (current) |
|-------------|--------------|
| Electron main process | `omega-desktop` native shell (`apps/shell`) |
| Go `omega-runtime` | C++ `omega-runtime` (`apps/runtime`) |
| Runtime HTTP `:9876` | Runtime HTTP **`127.0.0.1:9877`** |
| `electron-builder` output | Native packaging under **`dist/native/`** |
| Node sidecars at runtime | Unified Python venv at `~/.omega/venvs/unified` |

Migration details: [ELECTRON-REMOVAL.md](./ELECTRON-REMOVAL.md).

## Process model

```text
omega-desktop.exe          WebView2 (Win) / WKWebView (macOS) / WebKitGTK (Linux)
├── React UI               http://127.0.0.1:9777  (static Vite build)
├── Shell HTTP             http://127.0.0.1:9878  (browser, snip, webhooks)
└── omega-runtime (C++)    http://127.0.0.1:9877  (chat, agent, models, CS proxy)
    ├── stdio JSON-lines → omega-engine (GGUF / libomega_infer)
    ├── ContentStudioSupervisor → unified venv (uvicorn)
    └── optional sidecars (EXL2, ONNX GenAI) in same venv
```

The UI calls the runtime through `window.omega` (HTTP to `:9877`). Shell-only features (embedded browser, screen snip, open URL) use `:9878`.

## Build outputs

| Platform | Developer command | Staged app | Installer |
|----------|-------------------|------------|-----------|
| Windows | `build.bat` or `npm run build:win` | `dist/native/Omega/` | `dist/native/Omega-<version>-Setup.exe` |
| Linux | `./build.sh` or `npm run build:linux` | `dist/native/Omega/` | `dist/native/Omega-<version>-x86_64.AppImage` |
| macOS | `npm run build:mac` | `dist/native/Omega.app` | `dist/native/Omega-<version>.dmg` |

Default Windows install location: `%LOCALAPPDATA%\Programs\Omega\`.

Build log: `build-log.txt` at repo root.

## Developer quick start

```bash
git clone <repo>
cd Omega
npm install
npm run dev          # native shell + runtime + UI (see scripts/dev-native.mjs)
```

Production Windows build:

```bat
build.bat
```

Requires **Node.js 20+** (build only), **Git**, **Python 3.10+**, and a **C++ toolchain** (Visual Studio Build Tools on Windows). See [BUILDING-LLAMA-VARIANTS.md](./BUILDING-LLAMA-VARIANTS.md) for inference binary setup.

## Repo layout (v2)

```text
apps/shell/              omega-desktop — WebView host, tray, shell HTTP
apps/runtime/            omega-runtime — C++ HTTP API, agent, memory, CS delivery
apps/engine/             omega-engine — GGUF inference host
apps/desktop/            React UI (renderer), Content Studio Python tree, resources
packages/sdk/            Shared TypeScript types + runtime API client
scripts/                 build, package, native installer (NSIS, AppImage, dmg)
dist/native/             Packaged desktop output (not committed)
```

User data: `OMEGA_HOME` or `~/.omega` — models, sessions, plugins, Content Studio DB.

## Local HTTP API (runtime)

Base URL: **`http://127.0.0.1:9877`**

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Fast health probe |
| `GET /v1/runtime/info` | Version (`2.0.0`), build tag, paths |
| `GET /v1/runtime/status` | Cached runtime/model state (non-blocking) |
| `GET /v1/models`, `/v1/models/loaded` | Model inventory |
| `POST /v1/chat/send`, `/v1/chat/stream/poll` | Chat |
| `POST /v1/agent/run` | Agent runs |
| `POST /v1/embed` | Embeddings |
| `GET /v1/events/poll`, `/v1/events/sse` | UI event stream |

Full route list: `GET /v1/runtime/routes` while the app is running.

OpenAI-style `/v1/chat/completions` is used for **remote cloud providers**, not as the primary local surface. Local chat goes through `/v1/chat/*`.

## Content Studio (v2)

- Python backend lives in `apps/desktop/content-studio/`; packaged copy under `resources/content-studio/`.
- **Runtime** owns orchestration (`ContentStudioOrchestrator`, job delivery, GPU handoff) — not an Electron supervisor.
- **GPU modes** (Settings → Content Studio):
  - **Keep agent loaded** — chat model stays in VRAM; CS shares GPU with inference.
  - **Max performance** — chat model unloaded before render for maximum VRAM; runtime schedules reload after the job completes.
- CLI integration: `cs_invoke` subprocess from runtime (see Content Studio backend).

See [CONTENT-STUDIO.md](./CONTENT-STUDIO.md).

## Python at runtime

One unified venv (`~/.omega/venvs/unified`) serves Content Studio, finetune, plugins, stealth fetch, and optional sidecars. Setup: `POST /v1/python/setup` with profile `base` | `content` | `sidecar` | `full`.

Details: [RUNTIME-NODE.md](./RUNTIME-NODE.md) (filename is historical — doc describes Python, not Node).

## Platform shells

Windows / macOS / Linux shell differences: [PLATFORM-SHELLS.md](./PLATFORM-SHELLS.md).

## Related docs

| Doc | Topic |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Subsystems and data dirs |
| [INSTALLING.md](./INSTALLING.md) | End-user install |
| [FEATURES.md](./FEATURES.md) | Feature matrix |
| [ELECTRON-REMOVAL.md](./ELECTRON-REMOVAL.md) | What was removed |
