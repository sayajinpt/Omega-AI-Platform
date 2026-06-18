# Electron removal — Phase 8 complete + native parity (Windows)

> **Current product:** Omega **v2** — see [OMEGA-V2.md](./OMEGA-V2.md) for ports, build outputs, and repo layout.

Electron has been **removed from the repo** as the desktop host. Windows ships **`omega-desktop.exe` (WebView2)** + **`omega-runtime` (C++)** + static React UI. macOS and Linux use native WebView shells — see [PLATFORM-SHELLS.md](./PLATFORM-SHELLS.md).

**Node.js is not used at runtime.** Python sidecars run in the unified venv. See [RUNTIME-NODE.md](./RUNTIME-NODE.md) (unified Python doc).

## What was removed (Phase 8)

- `apps/desktop/src/main/` — entire Node/Electron main process
- `apps/desktop/src/preload/`
- `electron-vite`, `electron-builder`, `electron-updater`, `better-sqlite3`
- Default dev/build paths now use native shell (`npm run dev`, `build.bat` → native)

## Current process model (Windows)

```text
omega-desktop.exe (WebView2, apps/shell)
├── React UI @ http://127.0.0.1:9777
├── Shell HTTP @ :9878 (browser, overlays, webhooks, screen snip, open-url)
└── omega-runtime @ :9877 (spawned sibling)
    ├── HTTP/WS API (312 routes, all native)
    ├── ContentStudioOrchestrator (script gen + full runs)
    ├── agent / chat / tools / SQLite memory
    └── spawns omega-engine, Content Studio, Python sidecars
```

## Native parity shipped (Windows)

| Feature | Implementation |
|---------|----------------|
| Content Studio orchestration | `ContentStudioOrchestrator` — script LLM gen, pending runs, GPU choice cards, full `AgentRunCreate`, all `content_*` tools |
| Agent desktop tools | `AgentDesktopTools` — media, browser, web search/fetch, inference/model tools, choice cards |
| Agent platform tools | `AgentPlatformTools` — run_python, plugins, finetune, workforce, chat manage, clipboard, image gen |
| Auto-updater | `UpdaterService` — manifest from `OMEGA_UPDATE_MANIFEST` or `~/.omega/update-manifest.json`, NSIS launch |
| YouTube OAuth | `ContentStudioSupervisor::connect_youtube_oauth` + browser open |
| Generation download | `generationDownload` route (no 501 stub) |
| Session video reopen | Shell proxy `/v1/shell/media/reopenSessionVideo` |
| Edit menu cut/copy/paste | WebView2 `execCommand` in shell menu |
| Updater UI events | Publishes `omega:updater:status-event` |
| Chat choice cards + parts | `assistant_message_merge` + `ChatService::persist_assistant_message` — merges `chat_choice_card` output into SQLite `extras.parts` |
| Content Studio briefing cards | `needs_content_studio_briefing` + `build_content_briefing_tool_call` in orchestrator direct-tools path |
| `search_local_files` | Category-aware scan (Music/Videos/Downloads/Documents/code roots) |
| `run_shell` / `run_process` | Native subprocess via `AgentPlatformTools` (catalog still disabled by default) |
| `browser_stealth_fetch` | Unified venv + `stealth_fetch.py` (Playwright) |
| `voice_speak` | Windows SAPI (`ISpVoice`); macOS `say`; Linux `spd-say` / `espeak` |
| macOS / Linux shells | WKWebView + WebKitGTK hosts — see [PLATFORM-SHELLS.md](./PLATFORM-SHELLS.md) |
| `omega-engine` on macOS/Linux | POSIX fork/pipe client in `EngineClient` |
| Clipboard tools (mac/linux) | `pbcopy`/`pbpaste`, `wl-copy`/`wl-paste`, or `xclip` |
| Screen snip (mac/linux) | macOS `CGWindowListCreateImage`; Linux GdkPixbuf root capture |
| System tray (mac/linux) | macOS `NSStatusItem`; Linux `GtkStatusIcon` + close-to-tray |

## Remaining polish

1. **Linux `.deb` packager** — AppImage ships via `npm run package:appimage`; `.deb` still optional
2. **macOS notarization** — DMG ships via `npm run package:dmg`; codesign/notarize for Gatekeeper TBD
3. **Screen Recording permission** — macOS requires user approval for screen capture APIs
4. **Phase 6** — single unified Python venv (complete; see migration doc)

## Repo cleanup (Electron legacy)

- `apps/desktop/package.json` has no Electron deps; run `npm install` after pull to refresh `package-lock.json`
- Old electron-builder output under `apps/desktop/dist/desktop/` is removed by `npm run clean`
- Legacy script names (`ElectronIpcLike`, `run_via_electron`) renamed; see git history if grepping old terms

## Commands

```powershell
npm run dev          # UI watch + omega-desktop
npm run build:shell  # runtime + UI + shell + dist/native/Omega
.\build.bat          # full Windows installer pipeline
```

## Update manifest (optional)

Place `~/.omega/update-manifest.json`:

```json
{
  "version": "0.1.1",
  "url": "C:\\path\\to\\Omega-0.1.1-Setup.exe",
  "notes": "Release notes"
}
```

Or set `OMEGA_UPDATE_MANIFEST=https://example.com/omega/update-manifest.json`.
