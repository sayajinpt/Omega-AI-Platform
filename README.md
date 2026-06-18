 ▄▄▄▄▄▄▄▄▄▄▄  ▄▄       ▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄  ▄▄▄▄▄▄▄▄▄▄▄ 
▐░░░░░░░░░░░▌▐░░▌     ▐░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌
▐░█▀▀▀▀▀▀▀█░▌▐░▌░▌   ▐░▐░▌▐░█▀▀▀▀▀▀▀▀▀ ▐░█▀▀▀▀▀▀▀▀▀ ▐░█▀▀▀▀▀▀▀█░▌
▐░▌       ▐░▌▐░▌▐░▌ ▐░▌▐░▌▐░▌          ▐░▌          ▐░▌       ▐░▌
▐░▌       ▐░▌▐░▌ ▐░▐░▌ ▐░▌▐░█▄▄▄▄▄▄▄▄▄ ▐░▌ ▄▄▄▄▄▄▄▄ ▐░█▄▄▄▄▄▄▄█░▌
▐░▌       ▐░▌▐░▌  ▐░▌  ▐░▌▐░░░░░░░░░░░▌▐░▌▐░░░░░░░░▌▐░░░░░░░░░░░▌
▐░▌       ▐░▌▐░▌   ▀   ▐░▌▐░█▀▀▀▀▀▀▀▀▀ ▐░▌ ▀▀▀▀▀▀█░▌▐░█▀▀▀▀▀▀▀█░▌
▐░▌       ▐░▌▐░▌       ▐░▌▐░▌          ▐░▌       ▐░▌▐░▌       ▐░▌
▐░█▄▄▄▄▄▄▄█░▌▐░▌       ▐░▌▐░█▄▄▄▄▄▄▄▄▄ ▐░█▄▄▄▄▄▄▄█░▌▐░▌       ▐░▌
▐░░░░░░░░░░░▌▐░▌       ▐░▌▐░░░░░░░░░░░▌▐░░░░░░░░░░░▌▐░▌       ▐░▌
 ▀▀▀▀▀▀▀▀▀▀▀  ▀         ▀  ▀▀▀▀▀▀▀▀▀▀▀  ▀▀▀▀▀▀▀▀▀▀▀  ▀         ▀ 
                                                                 

Your machine. Your models. One app.

Omega is a desktop AI workspace: choose, download, run!

**Omega v2** ships as a **native desktop app** (WebView2 / WKWebView / WebKitGTK) with a **C++ runtime** — no Electron at install time. See [docs/OMEGA-V2.md](docs/OMEGA-V2.md).


Now u have the core engine "llama.cpp + the easy use UI of lmstudio + ollama backend for ollama especific model formats, servers,etc.. + Hermes style agent already native + CloakBrowser for native browsing and automation in protected services and websides"

with some native features as the Companion and Content Studio 

Its done with the intent to remove the complicated work for the commoun non tecnical person can also have access to local AI.



U can chat with them, hand work to agents, and keep everything in one place.

OS-aware smart file search avoids large searches if user use vague requests like for example :

- "play music from my pc".

- "open image X"

## He knows the OS your PC is running, he knhows the probable folders for commoun file formats files will be located)



Its already using latest llama.cpp and supports MTP (Multi-Token Prediction).

Also support ONNX and EXL2 formats as optional post install to avoid shipping very large executable.

If u use EXL2/ONNX models → Settings → Performance → select formats → Install.



## What sets Omega apart: the Companion

Most local stacks stop at “model loaded, good luck.” Omega adds a visible inference cockpit competitors rarely ship as a first-class product feature:

**The Companion** — A square floating widget with a 3D network view that follows inference state (idle, load, prefill, decode), plus a compute trace overlay: KV cache pressure, top‑k / confidence on native GGUF, and the active pipeline step.

- Quick chat and voice input route into your current main chat, detach to an always-on-top desktop window, and top-bar show/hide/detach controls make it a second surface for the same brain, not a screensaver.

- Other apps give you a chat box; Omega gives you a visible inference cockpit next to it.

The Companion answers questions other tools leave implicit: what is the model doing right now, and is my hardware actually using it well? That pairing is native to Omega, not a plugin.



** Native Omega agent inspired on Hermes agent.



No longer need a model hub and an agents platform and a pile of glue scripts.

Omega ships inference, chat, agents, tools, memory, plugins, office, studio, and gateways as one integrated desktop product.

Your data stays under your user folder (`~/.omega` on Linux/macOS, `%USERPROFILE%\.omega` on Windows) unless you point models or integrations elsewhere.


**Content and media — Content Studio for script and video workflows, local media search, embedded browser helpers, and chat that can carry attachments and screen snips from the Companion widget.


**settings:

To use the agent to produce content at request u firstly need to download and set respective default models for each task.

After all models existe localy and are set as defaults, omega will be able to manage them to complete the tasks user requests.


---

AI was used to help in this project.

this was made by one dude with a estupid AI that broke everything it was suposed to help fix xD ... Contain lots of bugs that i didnt face them yet to know they exist to eventualy fix them..


Fork it , build on it, make your own improved version. thats the point of all of this.


## Built on

Omega base code was heavily influenced from these projects, give them the deserved gratitude:

[Hermes desktop] (https://github.com/fathah/hermes-desktop)

[llama.cpp](https://github.com/ggml-org/llama.cpp)

[node-llama-cpp](https://github.com/withcatai/node-llama-cpp)

[Ollama](https://github.com/ollama/ollama)

[Microsoft WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (Windows shell)

[Playwright](https://playwright.dev/)

[cloakbrowser] (https://github.com/CloakHQ/CloakBrowser)

[Claw3D](https://github.com/iamlukethedev/claw3d)

Omega ships binaries and libraries from the stated projects.

License: [Apache-2.0](LICENSE)

---

<img width="1527" height="1112" alt="Captura de ecrã 2026-06-10 160444" src="https://github.com/user-attachments/assets/c13fa5b4-097e-46d8-89e0-ad81d7df20cd" />

<img width="1832" height="1291" alt="Captura de ecrã 2026-06-18 161227" src="https://github.com/user-attachments/assets/9afbe28c-ea85-4161-95c0-fc7b6c09f4b1" />

<img width="1833" height="1292" alt="Captura de ecrã 2026-06-18 161157" src="https://github.com/user-attachments/assets/557969ab-ca55-461b-9755-7c25e2c032fb" />

<img width="1837" height="1292" alt="Captura de ecrã 2026-06-18 161140" src="https://github.com/user-attachments/assets/bf3abf44-5779-4b18-8b87-e96d6549d013" />

<img width="1835" height="1292" alt="Captura de ecrã 2026-06-18 161120" src="https://github.com/user-attachments/assets/2f0a9bac-2939-4731-ab42-8eac06e57fe2" />

<img width="1548" height="872" alt="Captura de ecrã 2026-06-18 161041" src="https://github.com/user-attachments/assets/0afa4828-e3f3-416e-bd12-afe2e00a3c63" />

<img width="1197" height="1179" alt="Captura de ecrã 2026-06-15 235301" src="https://github.com/user-attachments/assets/dadad936-c35f-43fd-92ff-e8e0189fac0f" />

<img width="1637" height="1069" alt="Captura de ecrã 2026-06-12 192705" src="https://github.com/user-attachments/assets/bf6947e0-bd2b-4458-a30c-94b1ef59d51f" />

<img width="1638" height="1069" alt="Captura de ecrã 2026-06-12 192644" src="https://github.com/user-attachments/assets/bcce167a-ed74-4545-8277-c9752c99f23b" />

<img width="1582" height="1324" alt="Captura de ecrã 2026-06-12 160550" src="https://github.com/user-attachments/assets/3c987d66-b2e9-46ba-97e6-c35b2101e82a" />

<img width="2008" height="1387" alt="Captura de ecrã 2026-06-11 185000" src="https://github.com/user-attachments/assets/b292ae76-e597-4189-a478-9afae82559b5" />

<img width="1381" height="890" alt="Captura de ecrã 2026-06-10 223554" src="https://github.com/user-attachments/assets/759e4a7f-f18c-4104-a519-f430886198d0" />

<img width="1965" height="1300" alt="Captura de ecrã 2026-06-10 205609" src="https://github.com/user-attachments/assets/ef3a494d-7c87-44dd-836f-819a9b9cadee" />

<img width="1784" height="1136" alt="v1_ui (5)" src="https://github.com/user-attachments/assets/150ce84d-d058-4290-8e23-d7fb8524d9a4" />

<img width="1785" height="1132" alt="v1_ui (4)" src="https://github.com/user-attachments/assets/30500a82-d79b-41a9-8fd9-84dcd3c5f23c" />

<img width="1833" height="1291" alt="Captura de ecrã 2026-06-18 161305" src="https://github.com/user-attachments/assets/d058d03e-9fd7-46bc-a465-bdb8f11e314a" />





## Upgrading llama.cpp

Run the platform build script again (`build.bat` or `./build.sh`). Step 2 prompts for a new release tag, prebuilt vs source binaries, and your GPU stack.

## Quick start

**Development**

```bash
git clone <your-repo-url>
cd Omega
npm install
npm run dev
```

Optional: pick inference binaries before dev (same prompts as the installer build):

```bash
npm run setup:llama
# or non-interactive:
npm run setup:llama -- --yes --mode=binary --variant=win-vulkan
```

Set the variant for local runs:

```powershell
# Windows
$env:OMEGA_LLAMA_VARIANT = "win-vulkan"
```

```bash
# Linux
export OMEGA_LLAMA_VARIANT=linux-cuda
npm run dev
```

**Production installer (one script per OS)**

| Platform | Command | Output |
|----------|---------|--------|
| Windows | `build.bat` | `dist/native/Omega-*-Setup.exe` (staged app: `dist/native/Omega/`) |
| Linux | `./build.sh` | `dist/native/Omega-*.AppImage` |
| macOS | `npm run build:mac` | `dist/native/Omega-<version>.dmg` |

Each script runs **npm install**, interactive **llama.cpp setup** (release tag + prebuilt/source + GPU), then the **native packager** (`omega-desktop` + `omega-runtime` + bundled engines). Logs: `build-log.txt` in the repo root.

**Linux first run**

```bash
chmod +x build.sh
./build.sh
```

**GPU variants (pick one at setup — build on that OS only)**

| Variant ID | Use when |
|------------|----------|
| `win-cuda` | Windows + NVIDIA (CUDA) |
| `win-vulkan` | Windows + AMD/Intel/NVIDIA via Vulkan |
| `nvidia-vulkan-windows` | Windows + NVIDIA via Vulkan (explicit installer label) |
| `linux-cuda` | Linux x64 + NVIDIA (CUDA) |
| `linux-vulkan` | Linux x64 + Vulkan GPU |
| `nvidia-vulkan-linux` | Linux + NVIDIA via Vulkan (explicit installer label) |

The installer bundles **one** omega-infer stack (your choice) plus the matching `@node-llama-cpp` backend. See [docs/BUILDING-LLAMA-VARIANTS.md](docs/BUILDING-LLAMA-VARIANTS.md) for advanced/dev-only rebuilds.

**Requirements**

| | Windows | Linux |
|--|---------|-------|
| Node.js | 20+ | 20+ |
| npm, Git, Python | 3.10+ | 3.10+ (`python3`, `venv`) |
| Extra | Visual Studio Build Tools (source llama builds) | `unzip`, build-essential; AppImage often needs `libfuse2` |
| Extra (build) | CMake + VS Build Tools (C++ runtime/shell) | CMake, GTK/WebKit dev packages |

End-user install notes: [docs/INSTALLING.md](docs/INSTALLING.md).

---

## The Companion (floating inference widget)

The Companion is one of Omega’s signature features — the part that makes local inference feel present instead of invisible.

If you use Omega regularly, it is probably the piece you will notice first after chat itself.

It is a square floating panel with a 3D network view that reacts to what the model is actually doing (idle, loading weights, prefill, decode) — tied to the same signals as inference, not a decorative screensaver.

**Inside the panel**

- A slim compute trace overlay: KV cache usage, confidence / top‑k when running native GGUF, and which pipeline step is active.

Native GGUF paths use real sequence metrics from **omega-engine** (`libomega_infer`).

Ollama, sidecar, and remote backends show estimates.

- Quick chat (💬) at the bottom of the widget:

type or use the mic button.

Messages go to whatever chat you already have open in the main window (or the last one you used).

There is no separate Companion-only thread.

- Screen snip (⧉):

drag a rectangle, then save the image or send it into the active chat.

- Detach sends the widget to an always-on-top desktop window so it stays visible when the main app is minimized.

More detail: [docs/FEATURES.md](docs/FEATURES.md#omega-companion-floating-widget).

---

## What else is in the box

**Inference & models : 

Download GGUF models from Hugging Face, quantize, benchmark, and run via omega-engine (libomega_infer), or through bundled Ollama when that fits better.

Remote OpenAI-compatible providers work too. Tune GPU layers, context, and presets manually in Model Studio.


**Agent & tools :

Planner / executor loop with tool calls, memory search, and a visible step timeline.

Filesystem, sandboxed JS/Python, optional shell and web fetch, plus plugins under `~/.omega/plugins`.


**Office & gateways :

Native workforce floor; optional [Claw3D](https://github.com/iamlukethedev/claw3d) 3D office (off until you start it).

Chat bridges for Telegram, Discord, Slack, Matrix, email, and others. [docs/OFFICE-AND-INTEGRATIONS.md](docs/OFFICE-AND-INTEGRATIONS.md).


**Assistant :

Local media search, embedded browser / YouTube helpers, and the usual tool surface when enabled in settings.

---

## Local API

With the app running, **`omega-runtime`** exposes HTTP on **`127.0.0.1:9877`**. The shell serves UI on `:9777` and shell-only routes on `:9878`.

| Endpoint | Purpose |
|----------|---------|
| `GET /healthz` | Health check |
| `GET /v1/runtime/info` | Version, build tag, paths |
| `GET /v1/models` | Model inventory |
| `POST /v1/chat/send` | Send chat message |
| `POST /v1/chat/stream/poll` | Poll chat stream |
| `POST /v1/agent/run` | Agent run |
| `POST /v1/embed` | Embeddings |
| `GET /v1/events/poll` | UI event stream |

Full route catalog: `GET /v1/runtime/routes`. Overview: [docs/OMEGA-V2.md](docs/OMEGA-V2.md). Engine stdio protocol: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Chat attachments: [docs/CHAT-AND-MEDIA.md](docs/CHAT-AND-MEDIA.md).

---

## Project layout

```
apps/shell/       omega-desktop — native WebView host + shell HTTP
apps/runtime/     omega-runtime — C++ HTTP API, agent, memory, CS
apps/engine/      omega-engine — GGUF inference (libomega_infer)
apps/desktop/     React UI + Content Studio Python tree + resources
packages/sdk/     Shared TypeScript types + runtime API client
docs/             Feature and integration guides (start with OMEGA-V2.md)
```

User data: `OMEGA_HOME` or `~/.omega` — models, sessions, plugins, staged media.

---

## npm scripts

| Script | What it does |
|--------|----------------|
| `npm run dev` | Native shell + runtime + UI (`scripts/dev-native.mjs`) |
| `npm run build:shell` | Build runtime, UI, shell, stage `dist/native/Omega/` |
| `npm run build:win` / `build:linux` / `build:mac` | Full native packager + installer (use `build.bat` / `build.sh` for llama setup + log) |
| `npm run setup:llama` | Interactive llama.cpp version + GPU setup (writes `.omega/llama-setup.json`) |
| `npm run sync:llama-cpp` | Sync llama.cpp source into engine native tree |
| `npm run fetch:infer` | Download omega-infer binaries (`--variant=win-cuda`, etc.) |
| `npm run build:runtime` | Build C++ `omega-runtime` → `dist/runtime/` |
| `npm run build:native` | Optional: rebuild `libomega_infer` (see `apps/engine/native/`) |
| `npm run typecheck` | TypeScript check |
| `npm run clean` | Remove `dist/` and build artifacts |

---

## Documentation

| Guide | Contents |
|-------|----------|
| [docs/OMEGA-V2.md](docs/OMEGA-V2.md) | **v2 stack** — ports, layout, build outputs |
| [docs/FEATURES.md](docs/FEATURES.md) | Feature checklist |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Process model and subsystems |
| [docs/PLATFORM-SHELLS.md](docs/PLATFORM-SHELLS.md) | WebView2 / macOS / Linux shells |
| [docs/ELECTRON-REMOVAL.md](docs/ELECTRON-REMOVAL.md) | Migration from Electron |
| [docs/CHAT-AND-MEDIA.md](docs/CHAT-AND-MEDIA.md) | Attachments, vision, rich messages |
| [docs/OFFICE-AND-INTEGRATIONS.md](docs/OFFICE-AND-INTEGRATIONS.md) | Office, Claw3D, gateways |
| [docs/CONTENT-STUDIO.md](docs/CONTENT-STUDIO.md) | Content Studio |
| [docs/INSTALLING.md](docs/INSTALLING.md) | Install notes |
| [docs/MIXED-QUANT.md](docs/MIXED-QUANT.md) | Mixed quantization |

---

## License

Apache-2.0 — see [LICENSE](LICENSE).




## If u see this project useful for u , consider buying me a cofee.
 - PAYPAL - @alexandrepassarinho <img width="1527" height="1112" alt="Captura de ecrã 2026-06-10 160444" src="https://github.com/user-attachments/assets/002533af-4ca4-4f22-b2d1-83567a5916a9" />
