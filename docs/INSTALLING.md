# Installing Omega (end users)

You do **not** need Node.js, npm, or a developer toolchain. Omega v2 is distributed as a **native desktop app** (WebView shell + C++ runtime).

## Linux

1. Download `Omega-<version>.AppImage` (from releases or your build output).
2. Make it executable: `chmod +x Omega-*.AppImage`
3. Run it (AppImage may require FUSE: `sudo apt install libfuse2` on some distributions).

Same bundled components as Windows (desktop app, inference engines, Content Studio, optional Claw3D).

## Windows

The setup wizard uses a **terminal-style console** with the Omega banner: welcome screen, deploy preview, then a live log while files install.

1. Download `Omega-<version>-Setup.exe` (from releases or your build output).
2. Run the installer and follow the prompts.
3. Launch **Omega** from the Start menu or desktop shortcut.

The installer includes everything required to run locally:

| Component | Purpose |
|-----------|---------|
| **omega-desktop** | Native shell — UI host, tray, shell HTTP |
| **omega-runtime** | C++ API — chat, agent, memory, Content Studio orchestration |
| **omega-engine** | GGUF inference (`libomega_infer` + llama.cpp) |
| **omega-ollama** | Safetensors, HF folders, AWQ/GPTQ, and other formats |
| **omega-infer / quantize tools** | MTP speculative worker and GGUF quantization |

Models are **not** bundled (they are large). Download them inside the app via **Model Studio**, or copy GGUF / HuggingFace folders into your models directory (shown in **Settings**).

## After install

1. Complete onboarding (models folder, optional HF token).
2. Download or add a model.
3. Select it in chat and start talking.

Optional: tune GPU layers and context per model in Model Studio.

## Troubleshooting

- **“Engine missing”** — The install is incomplete. Reinstall from the official `.exe`; do not copy only the `.exe` without the rest of the install folder.
- **Slow first load** — Non-GGUF models are registered with the bundled Ollama engine on first use; this is normal.
- **GPU not used** — Install the latest GPU drivers (NVIDIA / AMD / Intel). Omega picks CUDA, Vulkan, or Metal automatically when available.

## For developers only

Building from source (not needed for end users):

| Platform | Command |
|----------|---------|
| Windows | `build.bat` |
| Linux | `chmod +x build.sh && ./build.sh` |

The build scripts prompt for llama.cpp release, prebuilt vs source inference binaries, and NVIDIA CUDA vs Vulkan. Requires Node.js 20+, Git, Python 3.10+, and a C++ toolchain (CMake / Visual Studio Build Tools) on PATH. Linux also needs `unzip` and build tools. First build downloads Claw3D and engine binaries — allow time and network.

Details: [BUILDING-LLAMA-VARIANTS.md](./BUILDING-LLAMA-VARIANTS.md) · v2 overview: [OMEGA-V2.md](./OMEGA-V2.md).

Output: `dist/native/` (`Omega-*-Setup.exe`, AppImage, or `.dmg`)  
Log: `build-log.txt`
