# Omega Architecture

Omega is a **single-system local AI operating system** (v2, runtime **2.0.0**): one native desktop application that bundles inference, agents, memory, tools, a local API, and a React UI. Nothing at runtime depends on Electron, external inference servers, or third-party agent frameworks.

Start here for the v2 map: [OMEGA-V2.md](./OMEGA-V2.md).

## Process model (Windows — native shell)

```
┌─────────────────────────────────────────────────────────────┐
│  omega-desktop.exe (WebView2, apps/shell)                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ React UI     │  │ Shell HTTP   │  │ Tray / menu /    │  │
│  │ :9777        │  │ :9878        │  │ screen snip      │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────┘  │
│         │ HTTP (window.omega → :9877)                       │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ omega-runtime (C++, apps/runtime)                     │  │
│  │ Agent · chat · tools · SQLite · Content Studio proxy   │  │
│  └─────┬────────────────────────────────────────────────┘  │
│        │ stdio JSON-lines                                   │
│        ▼                                                    │
│  ┌────────────────────────────────────────┐               │
│  │ omega-engine (C++ binary, bundled)        │               │
│  └────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

The UI talks to **`omega-runtime` over HTTP** on `127.0.0.1:9877`. Desktop integrations (embedded browser, overlays) use shell HTTP on `:9878`.

## Subsystems

| Subsystem | Location | Responsibility |
|-----------|----------|----------------|
| **Engine** | `apps/engine` | GGUF registry, load/evict, streaming generate/chat/embed |
| **Runtime** | `apps/runtime` | HTTP API, agent, chat, memory (SQLite), tools, workflows |
| **Shell** | `apps/shell` | WebView2 host, static UI server, tray, shell HTTP |
| **UI** | `apps/desktop/src/renderer` | Chat, settings, Content Studio pages, debug |
| **Shared API** | `apps/desktop/src/shared` | `omega-api.ts`, HTTP bridge for `window.omega` |

## Inference backends

| Backend | Role |
|---------|------|
| **omega-engine** | Required for local GGUF — linked `libomega_infer`, up to 2 resident models |
| **omega-ollama** | Safetensors, HF folders, AWQ/GPTQ, and other non-GGUF formats |
| **Sidecar** | Optional EXL2 / ONNX GenAI (Python venv, post-install) |
| **Cloud APIs** | OpenAI-compatible providers configured in Settings |

Model load settings (GPU layers, context size, presets) are configured manually in Model Studio and Settings.

## Data directories

| Path | Contents |
|------|----------|
| `~/.omega/` | Home directory (`OMEGA_HOME`) |
| `~/.omega/models/` | Installed `.gguf` files |
| `~/.omega/workspace/` | Tool sandbox root |
| `~/.omega/memory.db` | SQLite memory + sessions |
| `~/.omega/config.json` | User settings |

## What Omega is not

- Not a wrapper around external inference daemons
- Not a GUI that connects to separate agent services
- Not a multi-backend router for the same GGUF path

Everything runs inside the Omega install boundary.

## Native runtime

Omega desktop on **Windows, macOS, and Linux** uses **`omega-desktop` + `omega-runtime`**. See:

- [OMEGA-V2.md](./OMEGA-V2.md) — v2 stack, ports, build outputs
- [ELECTRON-REMOVAL.md](./ELECTRON-REMOVAL.md) — migration from Electron
- [RUNTIME-NODE.md](./RUNTIME-NODE.md) — unified Python venv (Content Studio, sidecars)
- [PLATFORM-SHELLS.md](./PLATFORM-SHELLS.md) — WebView2 / macOS / Linux
- `apps/runtime/` — C++ HTTP entry (port **9877**)
- `engines/python-unified/` — single Python venv installer
