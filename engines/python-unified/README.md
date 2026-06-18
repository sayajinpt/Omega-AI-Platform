# Unified Python environment for Omega

Single venv at **`~/.omega/venvs/unified`** for all Python-dependent features:

- Content Studio API + generation workers (until ported to C++)
- Finetune training scripts
- Agent `run_python` / terminal snippets
- Sidecar ONNX / EXL2 (optional components)
- HF download helpers

## Install

**Packaged app / first run:** `POST /v1/python/setup` with `{ "profile": "base" | "content" | "full" }` — implemented in C++ (`apps/runtime/src/python/venv_setup.cpp`). The Content Studio UI “Set up environment” button uses profile **`content`** (adds SQLAlchemy, Alembic, etc. into the same unified venv). There is no per-feature venv at runtime.

**Why not in the installer?** The venv is created with the user’s system Python (`py -3.10+`), can be 1GB+, and optional GPU wheels vary by machine — so Omega installs it on first use instead of bundling it in the NSIS package.

**Dev (manual):**

```powershell
py -3.12 -m venv $env:USERPROFILE\.omega\venvs\unified
& $env:USERPROFILE\.omega\venvs\unified\Scripts\python.exe -m pip install -r engines/python-unified/requirements-unified.txt
& $env:USERPROFILE\.omega\venvs\unified\Scripts\python.exe -m playwright install chromium
```

Legacy `run-setup.mjs` is deprecated; use the API or pip commands above.

## Profiles

| Profile | Installs |
|---------|----------|
| `base` (default) | fastapi, uvicorn, httpx, pillow, playwright |
| `sidecar` | + onnxruntime-genai, exllamav2, torch (from sidecar requirements) |
| `content` | + Content Studio `requirements-omega.txt` (no torch media by default) |
| `full` | base + sidecar + content + `requirements-local-media.txt` |

## Migration

Phase 6 complete: all Python features share `~/.omega/venvs/unified`. Legacy per-feature venvs are no longer created by the runtime.
