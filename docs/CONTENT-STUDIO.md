# Content Studio (built into Omega)

Content Studio is **bundled inside Omega** — multi-platform video generation, schedules, series, and social publishing. No separate install.

## Layout

```
apps/desktop/
  content-studio/          ← Python backend + generation_models (in repo)
    backend/               ← FastAPI + Alembic
    generation_models/
  src/renderer/            ← Content Studio React pages (served with main UI)
```

Packaged installs load the same tree from `resources/content-studio/`.

**Runtime orchestration** lives in **`omega-runtime` (C++)** — `ContentStudioSupervisor`, `ContentStudioOrchestrator`, and job delivery — not in a desktop main process.

## Build step

Content Studio is prepared automatically when you run **`build.bat`** (Windows installer) or `npm run build:win`. Build scripts may create `backend/.venv` for dev validation; that folder is **stripped** from the NSIS installer.

At **runtime**, the API and workers use the **unified Python venv** at `~/.omega/venvs/unified`. First-time setup in the Content Studio tab calls `POST /v1/python/setup` with profile `content`.

User data: `~/.omega/content-studio/` (DB, storage). TTS/image weights: `~/.omega/models/generation-models/`.

## GPU modes

Settings → Content Studio → **GPU mode**:

| Mode | Behavior |
|------|----------|
| **Keep agent loaded** | Chat model stays in VRAM; Content Studio shares the GPU with inference. Faster handoff back to chat after a job. |
| **Max performance** | Chat model is unloaded before render to free VRAM for generation. **`omega-runtime`** waits for the pipeline worker to exit, then **reloads the chat model** when the job completes. |

Integration with the Python backend uses **`cs_invoke`** (subprocess CLI from runtime), not Electron IPC.

## Settings

- **Omega tools** — default TTS / image models (Settings → Omega tools)
- **Content Studio APIs** — social keys (Settings → Content Studio & social APIs)

## Agent tools

`content_create_run`, `content_run_status`, `content_list_projects`, `content_series_*`, `content_schedule_*`, `content_social_*`

## See also

- [OMEGA-V2.md](./OMEGA-V2.md) — process model and ports
- [apps/desktop/content-studio/README.md](../apps/desktop/content-studio/README.md) — repo tree notes
