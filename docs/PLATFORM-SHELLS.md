# Native shells — macOS and Linux

Windows ships via **WebView2** (`apps/shell`). **macOS** and **Linux** now ship via native webview hosts in the same `apps/shell` tree.

## Architecture (all platforms)

```text
omega-desktop (native webview host)
├── Static React UI (Vite build → dist/ui)
├── Shell HTTP :9878 (browser overlay, webhooks, screen snip routes)
└── omega-runtime :9877 (C++ — cross-platform)
```

The **runtime and UI are platform-agnostic**. `apps/shell` selects WebView2 / WKWebView / WebKitGTK at build time.

## macOS (WKWebView)

| Component | Implementation |
|-----------|----------------|
| WebView | `webview_host_mac.mm` + `main_mac.mm` |
| HTTP server | Shared `shell_http_server.cpp` (httplib) |
| Menu / tray | `shell_menu_mac.mm` + `shell_tray_mac.mm` (NSStatusItem, close-to-tray) |
| Packaging | `npm run build:mac` → `dist/native/Omega.app` + `Omega-{version}.dmg` |
| Bundle layout | `Contents/Resources/{ui,runtime,engine,bin}` |

**Requirements:** Xcode CLI tools, CMake, `npm run build:runtime` on macOS.

## Linux (WebKitGTK)

| Component | Implementation |
|-----------|----------------|
| WebView | `webview_host_linux.cpp` + GTK 3 |
| Menu / tray | `shell_menu_linux.cpp` + `shell_tray_linux.cpp` (GtkStatusIcon) |
| HTTP server | Shared `shell_http_server.cpp` |
| Packaging | `npm run build:linux` → `dist/native/Omega/` + `Omega-{version}-x86_64.AppImage` |
| Deps | `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`, CMake |

**Requirements:** GTK3 + WebKit2GTK 4.1 development packages.

## Platform notes

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Main webview | WebView2 | WKWebView | WebKitGTK |
| Embedded browser | WebView2 overlay | WKWebView child | WebKitGTK fixed overlay |
| Avatar overlay | WebView2 popup | NSWindow + WKWebView | GTK toplevel |
| Screen snip | GDI+ capture | `CGWindowListCreateImage` | GdkPixbuf root capture |
| System tray | NOTIFYICONDATA | NSStatusItem | GtkStatusIcon |
| Shell events to UI | `PostWebMessageAsJson` | `window.postMessage` | `window.postMessage` |

## Runtime (non-Windows)

- **omega-engine** — POSIX fork/pipe JSON-line client in `EngineClient`
- **Content Studio** — POSIX `fork`/`exec` uvicorn path in `ContentStudioSupervisor`
- **Clipboard / TTS** — `pbcopy`/`pbpaste`, `wl-clipboard`/`xclip`, `say` / `spd-say` / `espeak`
- **Terminal snippets** — Python/shell/Node via `popen`
- **Updater** — `open` / `xdg-open` for `.dmg`, AppImage, or HTTP manifest URLs
- **OAuth / open URL** — `open_url_in_browser()` in shell platform helpers

## Commands

```bash
# macOS
npm run build:mac
npm run package:dmg

# Linux
npm run build:linux
npm run package:appimage

# Windows (unchanged)
# .\build.bat
# or
# npm run build:win-native
```

## CMake

`apps/shell/CMakeLists.txt` branches on `WIN32`, `APPLE`, and Linux (`else()`). Shared sources: `shell_context`, `static_server`, `shell_http_server`.
