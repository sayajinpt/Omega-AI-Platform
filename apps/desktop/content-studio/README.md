# Content Studio (bundled in Omega)

Python FastAPI backend and generation assets used by the **Content Studio** tab in Omega Desktop (v2 native stack).

- **Backend:** `backend/` — API, pipelines, social publishing  
- **Generation models:** `generation_models/` — local TTS / image helpers  
- **Orchestration:** `omega-runtime` (C++) — supervisor, job delivery, GPU handoff, `cs_invoke`

This tree is part of the Omega repository.

**Runtime (packaged app):** Content Studio does **not** use `backend/.venv`. The API and workers run under the **single unified venv** at `~/.omega/venvs/unified` (same as agent Python, sandboxes, sidecar, finetune). First-time setup in the Content Studio tab calls `POST /v1/python/setup` with profile `content` to pip-install `requirements-omega.txt` into that venv.

**Build only:** `scripts/ensure-content-studio.mjs` may create `backend/.venv` for dev/CI validation; that folder is **stripped** from the NSIS installer.

Run **`build.bat`** at the Omega repo root (or `npm run build:win`). Output: `dist/native/Omega-*-Setup.exe`.

**GPU modes:** *Keep agent loaded* vs *Max performance* (unload chat model for VRAM, reload after job) — see [docs/CONTENT-STUDIO.md](../../docs/CONTENT-STUDIO.md).

User data: database and exports under `~/.omega/content-studio/`; TTS/image weights under `~/.omega/models/generation-models/` (same tree as other Omega models).
