# Python at runtime (unified venv)

Omega ships **no Electron** and **no Node.js at runtime**. The desktop host is native (`omega-desktop` + WebView). All orchestration lives in **`omega-runtime` (C++)**, which bootstraps a single unified Python environment at `~/.omega/venvs/unified/`.

## Architecture

```text
omega-desktop (C++ WebView shell)
└── omega-runtime (C++)
    ├── HTTP/WS, chat, tools, SQLite, engine client
    └── ~/.omega/venvs/unified
        ├── Content Studio (uvicorn)
        ├── Finetune, run_python, terminal Python snippets
        ├── stealth_fetch.py (Playwright)
        ├── plugin_invoke.py (index.py plugins)
        ├── Sidecar stack (exllamav2, onnxruntime-genai) — profile sidecar/full
        └── Router models (optimum/onnxruntime) — profile full
```

System Python 3.10+ is used **once** to create the venv via C++ (`find_system_python_launcher()` in `venv_setup.cpp`). End users do not need Node.

## What uses Python

| Use | Script / stack | Spawned by |
|-----|----------------|------------|
| **First-run setup** | `requirements-unified.txt` + optional profiles | `POST /v1/python/setup` → `run_unified_venv_setup()` |
| **Content Studio API** | uvicorn + backend deps | `ContentStudioSupervisor` |
| **Finetune / run_python** | unified venv | `AgentPlatformTools`, finetune runner |
| **Stealth browser fetch** | `python-runtime/stealth_fetch.py` + Playwright | `browser_stealth_fetch` tool |
| **Plugin tools** | `python-runtime/plugin_invoke.py` (`index.py` only) | `plugin_runner.cpp` |
| **Terminal Python snippets** | unified venv | `terminal_store.cpp` |
| **Sidecar engines** | sidecar `requirements.txt` in unified venv | `SidecarService::install` |
| **Router models** | router-models `requirements.txt` | `RouterModelsService::setup_python` |

## What does **not** use Python or Node at runtime

- Desktop UI (static React over HTTP)
- `omega-runtime` HTTP/WebSocket API (C++)
- Chat, memory, sessions, orchestrator, most tools (C++)
- `omega-engine` inference (C++)
- Arbitrary JavaScript execution (`run_js` removed — use `run_python` or native tools)

## Configuration

- `OMEGA_PYTHON_UNIFIED_ROOT` — override path to `engines/python-unified` (requirements source)
- `OMEGA_PYTHON_RUNTIME_DIR` — override `python-runtime/` scripts directory
- `OMEGA_PYTHON_UNIFIED_VENV` — override venv location (see `paths.cpp`)

## Setup API

```http
POST /v1/python/setup
{ "profile": "base" | "content" | "sidecar" | "full" }
```

Progress events stream over the existing Python setup channel. Profiles add optional pip stacks (Content Studio, sidecar, router models). Base profile always installs Playwright and runs `playwright install chromium`.

## Build-time vs runtime

**npm / Node at build time** (developer machine only): Vite UI build, route catalog generation, packaging scripts. Packaged installs do not require npm or Node unless you are developing Omega itself.

## Legacy

Previous Node sidecars (`plugin-invoke.cjs`, `stealth-fetch.cjs`, `run-setup.mjs` via Node) are superseded by C++ venv setup and `apps/runtime/resources/python-runtime/*.py`. Dev-only `engines/*/run-setup.mjs` scripts may remain for manual testing but are not used by the packaged runtime.
