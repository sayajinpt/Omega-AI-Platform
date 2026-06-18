# Building Omega from source (any machine)

Use this when you cloned [Omega-AI-Platform](https://github.com/sayajinpt/Omega-AI-Platform) or downloaded the ZIP — not for end users installing the `.exe` release.

## Requirements

| Tool | Version | Notes |
|------|---------|--------|
| Node.js | 20+ | From [nodejs.org](https://nodejs.org) — use system install, not IDE-bundled Node |
| npm | ships with Node | |
| Git | any recent | Claw3D fetch during build |
| Python | 3.10+ | Content Studio / unified venv setup |
| CMake + C++ toolchain | Windows: **Visual Studio** with “Desktop development with C++” | Builds `omega-engine`, `omega-runtime`, `omega-desktop` |

Optional for GPU builds:

- **NVIDIA** — CUDA toolkit (matches llama.cpp prebuilt, or build from source)
- **Vulkan** — [LunarG Vulkan SDK](https://vulkan.lunarg.com/) when using Vulkan variant

## Clone location

You can build from **any folder**, including:

- `C:\dev\Omega`
- `C:\Users\you\Downloads\Omega-AI-Platform-main\Omega-AI-Platform-main`

Long paths (Downloads, Desktop, OneDrive) automatically use a **per-clone** short CMake dir under `%LOCALAPPDATA%\O\eb-<id>\` so builds do not depend on where *you* originally cloned the repo.

**Do not** reuse one Omega folder’s CMake cache after copying the tree to a new path — the build scripts clear stale cache automatically.

## Windows build

```bat
build.bat
```

Steps: clean npm → `npm install` → interactive llama.cpp setup → full native packager + NSIS installer.

Output:

- Staged app: `dist\native\Omega\`
- Installer: `dist\native\Omega-<version>-Setup.exe`
- Log: `build-log.txt`

Run **`build.bat` from Explorer or a normal PowerShell window**, not always from an IDE terminal (mixed Node PATH can break `npm install`).

## Linux / macOS

```bash
chmod +x build.sh && ./build.sh   # Linux
npm run build:mac                 # macOS
```

## If build fails

| Symptom | Fix |
|---------|-----|
| `xcopy` / llama source copy failed | Pull latest `main` (uses Node `fs.cpSync`, not `xcopy`) |
| CMake source path mismatch | Pull latest `main`; or delete `%LOCALAPPDATA%\O\eb` and `%LOCALAPPDATA%\O\eb-*` |
| PowerShell parse error in `build-engine.ps1` | Pull latest `main` |
| `npm install` crash / corrupt modules | Close IDE, delete `node_modules`, run `build.bat` from Explorer |
| Missing cmake | Install VS Build Tools or CMake; add to PATH |

Validate PowerShell scripts locally:

```bat
node scripts\validate-build-scripts.mjs
```

## What is not in git

These are created on each machine during build:

- `node_modules/`
- `dist/` (binaries, installer)
- `.omega/cache/` (llama.cpp source cache)
- `%LOCALAPPDATA%\O\eb-*` (short-path engine build, per clone)

See also: [BUILDING-LLAMA-VARIANTS.md](./BUILDING-LLAMA-VARIANTS.md), [OMEGA-V2.md](./OMEGA-V2.md).
