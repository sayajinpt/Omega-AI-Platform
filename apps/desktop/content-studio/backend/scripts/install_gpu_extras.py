"""Install CUDA PyTorch + FlashAttention for Content Studio GPU transformers (TTS, diffusers).

Wheels are stored under ~/.omega/content-studio/prebuilt-wheels/ (downloaded on first GPU
setup, not shipped in the Omega installer). Dev builds may still keep wheels under
content-studio/prebuilt-wheels/. Install searches user cache, repo bundle, then network.

Windows: kingbri1/flash-attention prebuilds (mjun0812 has Linux-only wheels).
Linux: mjun0812/flash-attention-prebuild-wheels.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

# backend/scripts/install_gpu_extras.py -> content-studio/prebuilt-wheels
DEFAULT_PREBUILT_WHEELS = Path(__file__).resolve().parents[2] / "prebuilt-wheels"

MJUN_RELEASE = "v0.7.16"
MJUN_BASE = (
    "https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/"
    f"{MJUN_RELEASE}"
)

KINGBRI_RELEASE = "v2.8.3"
KINGBRI_BASE = f"https://github.com/kingbri1/flash-attention/releases/download/{KINGBRI_RELEASE}"

DOGI_RELEASE = "v2.8.3-cu130-py313"
DOGI_BASE = f"https://github.com/D-Ogi/flash-attention/releases/download/{DOGI_RELEASE}"

PLISGOOD_RELEASE = "v2.8.3"
PLISGOOD_BASE = (
    "https://github.com/PLISGOOD/flash-attention-windows-wheels/releases/download/"
    f"{PLISGOOD_RELEASE}"
)

# cu130 wheels — must match torch from cu130 index (not cu128 kingbri).
WILDMINDER_CU130_HF = "https://huggingface.co/Wildminder/AI-windows-whl/resolve/main"
USSOEWWIN_CU130_HF = "https://huggingface.co/ussoewwin/Flash-Attention-2_for_Windows/resolve/main"
# Legacy sm_120-only wheel (deprecated — ussoewwin cu130torch2.11 builds cover RTX 50xx).
IXAONE_BLACKWELL_HF = "https://huggingface.co/IxaOne/flash-attn-blackwell-win-cp313/resolve/main"
BLACKWELL_CP313_WHEEL = "flash_attn-2.8.3-cp313-cp313-win_amd64.whl"
WINDOWS_CU130_TORCH_FALLBACKS = ("2.11.0", "2.10.0")

# Windows cp313 + cu128 wheels (legacy Ampere/Ada only — do not use when torch is cu130).
WINDOWS_CU128_TORCH_FALLBACKS = ("2.9.0", "2.8.0", "2.7.0")

# Flash-attn Windows wheels are built for this exact torch (pip ``>=2.10`` pulls 2.12 → DLL failure).
PINNED_CUDA_TORCH = "2.11.0"

# When bundling wheels, pin torch to match published cu130 + cp313 flash-attn.
WINDOWS_BUNDLE_TORCH = PINNED_CUDA_TORCH

# ussoewwin publishes matching cu130 wheels per torch; try newest FA first.
USSOEWWIN_FA_VERSIONS = ("2.9.0", "2.8.4", "2.8.3")


def _omega_home() -> Path:
    raw = os.environ.get("OMEGA_HOME", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return Path.home() / ".omega"


def _user_prebuilt_wheels_dir() -> Path:
    return _omega_home() / "content-studio" / "prebuilt-wheels"


def _prebuilt_wheels_search_dirs() -> list[Path]:
    """Ordered search paths for cached flash-attn wheels."""
    dirs: list[Path] = []
    seen: set[Path] = set()

    def add(p: Path) -> None:
        resolved = p.expanduser().resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        dirs.append(resolved)

    raw = os.environ.get("OMEGA_PREBUILT_WHEELS_DIR", "").strip()
    if raw:
        add(Path(raw))
    add(_user_prebuilt_wheels_dir())
    add(DEFAULT_PREBUILT_WHEELS)
    return dirs


def _python_tag() -> str:
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _installed_torch_cuda() -> tuple[str, str] | None:
    """Return (torch_version '2.9.0', cuda_short '128') from the active environment."""
    try:
        import torch
    except ImportError:
        return None
    ver = torch.__version__.split("+")[0]
    parts = ver.split(".")
    if len(parts) < 2:
        return None
    torch_ver = f"{parts[0]}.{parts[1]}" + (f".{parts[2]}" if len(parts) > 2 else "")
    cuda = torch.version.cuda or ""
    if not cuda:
        # e.g. torch 2.9.0+cu128 in __version__ but version.cuda empty on some builds
        m = re.search(r"\+cu(\d+)", torch.__version__)
        cuda_short = m.group(1) if m else ""
    else:
        cuda_short = cuda.replace(".", "")[:3]
    if len(cuda_short) < 2:
        return None
    return torch_ver, cuda_short


def _kingbri_wheel_name(torch_ver: str, cuda_short: str) -> str:
    py = _python_tag()
    return (
        f"flash_attn-2.8.3+cu{cuda_short}torch{torch_ver}cxx11abiFALSE-{py}-{py}-win_amd64.whl"
    )


def _ussoewwin_cu130_wheel_name(torch_ver: str, fa_version: str) -> str:
    py = _python_tag()
    return f"flash_attn-{fa_version}+cu130torch{torch_ver}cxx11abiTRUE-{py}-{py}-win_amd64.whl"


def _wildminder_cu130_wheel_name(torch_ver: str) -> str:
    py = _python_tag()
    return f"flash_attn-2.8.3+cu130torch{torch_ver}cxx11abiTRUE-{py}-{py}-win_amd64.whl"


def _cu130_torch_versions_for_candidates() -> list[str]:
    """
    Only try flash wheels built for the torch already in the venv.

    Mixing e.g. cu130torch210 wheels on torch 2.11 causes "procedure not found" on every GPU.
    """
    installed = _installed_torch_cuda()
    if installed and installed[1] == "130":
        return [installed[0]]
    return [PINNED_CUDA_TORCH]


def _dogi_cu130_wheel_name(torch_ver: str) -> str:
    """D-Ogi tags torch 2.10 as ``torch210`` (no cxx11abi segment)."""
    py = _python_tag()
    parts = torch_ver.split(".")
    major = parts[0]
    minor = parts[1] if len(parts) > 1 else "0"
    return f"flash_attn-2.8.3+cu130torch{major}{minor}-{py}-{py}-win_amd64.whl"


def _cuda_capability() -> tuple[int, int]:
    try:
        import torch

        if torch.cuda.is_available():
            cap = torch.cuda.get_device_capability(0)
            if isinstance(cap, (tuple, list)) and len(cap) >= 2:
                return int(cap[0]), int(cap[1])
    except Exception:  # noqa: BLE001
        pass
    return (0, 0)


def _is_blackwell_gpu() -> bool:
    """RTX 50xx (sm_120) needs flash-attn built with TORCH_CUDA_ARCH_LIST=12.0."""
    major, _minor = _cuda_capability()
    return major >= 12


def _is_blackwell_sm120_wheel(name: str) -> bool:
    return name.lower() == BLACKWELL_CP313_WHEEL.lower()


def _wheel_matches_torch(wheel_name: str, torch_ver: str, cuda_short: str) -> bool:
    """Reject cached cu128 wheels when the venv has cu130 torch (common mismatch symptom)."""
    n = wheel_name.lower()
    cu = f"cu{cuda_short}"
    if cu not in n:
        return False
    if f"torch{torch_ver}" in n:
        return True
    parts = torch_ver.split(".")
    if len(parts) >= 2 and f"torch{parts[0]}.{parts[1]}" in n:
        return True
    compact = f"{parts[0]}{parts[1]}" if len(parts) >= 2 else torch_ver.replace(".", "")
    return f"torch{compact}" in n


def _mjun_wheel_name(torch_ver: str, cuda_short: str) -> str:
    py = _python_tag()
    parts = torch_ver.split(".")
    major = parts[0]
    minor = parts[1] if len(parts) > 1 else "0"
    plat = "linux_x86_64"
    return f"flash_attn-2.8.3+cu{cuda_short}torch{major}.{minor}-{py}-{py}-{plat}.whl"


def _flash_attn_wheel_candidates() -> list[tuple[str, str]]:
    """Ordered (filename, download_url) pairs to try."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(name: str, base: str) -> None:
        if name in seen:
            return
        seen.add(name)
        out.append((name, f"{base}/{quote(name, safe='')}"))

    installed = _installed_torch_cuda()

    if sys.platform == "win32":

        def add_cu130(torch_versions: list[str]) -> None:
            py = _python_tag()
            for torch_ver in torch_versions:
                for fa_ver in USSOEWWIN_FA_VERSIONS:
                    add(_ussoewwin_cu130_wheel_name(torch_ver, fa_ver), USSOEWWIN_CU130_HF)
                add(_wildminder_cu130_wheel_name(torch_ver), WILDMINDER_CU130_HF)
                if torch_ver.startswith("2.10"):
                    add(_dogi_cu130_wheel_name(torch_ver), DOGI_BASE)
            if py == "cp311":
                plis = "flash_attn-2.8.3+cu130torch2.11.0cxx11abiTRUE-cp311-cp311-win_amd64.whl"
                add(plis, PLISGOOD_BASE)

        def add_cu128(torch_versions: list[str]) -> None:
            for torch_ver in torch_versions:
                add(_kingbri_wheel_name(torch_ver, "128"), KINGBRI_BASE)

        torch_cu130 = _cu130_torch_versions_for_candidates()
        torch_cu128: list[str] = []
        if installed:
            _tv, cuda_short = installed
            if cuda_short == "128":
                torch_cu128.append(_tv)
        for tv in WINDOWS_CU128_TORCH_FALLBACKS:
            if tv not in torch_cu128:
                torch_cu128.append(tv)

        if installed and installed[1] == "130":
            add_cu130(torch_cu130)
            return out
        if installed and installed[1] == "128":
            add_cu128(torch_cu128)
            return out
        # Fresh venv: Omega installs cu130 torch first — only wheels matching the pinned torch.
        add_cu130(torch_cu130)
        return out

    # Linux / other: mjun prebuilds (no Windows wheels in that repo).
    specs = []
    if installed:
        specs.append(installed)
    specs.extend((tv, "128") for tv in ("2.9", "2.8", "2.7", "2.10"))
    for torch_ver, cuda_short in specs:
        add(_mjun_wheel_name(torch_ver, cuda_short), MJUN_BASE)
    return out


def _flash_attn_wheel_name() -> str | None:
    candidates = _flash_attn_wheel_candidates()
    return candidates[0][0] if candidates else None


def _flash_attn_wheel_url() -> str | None:
    candidates = _flash_attn_wheel_candidates()
    return candidates[0][1] if candidates else None


def _pip_install(args: list[str]) -> bool:
    extra: list[str] = []
    if len(args) == 1:
        target = args[0]
        if target.endswith(".whl") or target.startswith("http://") or target.startswith("https://"):
            extra = ["--no-deps"]
    r = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", *extra, *args],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0 and r.stderr:
        print(r.stderr.strip(), file=sys.stderr, flush=True)
    return r.returncode == 0


def _flash_attn_last_error() -> str | None:
    try:
        gen = Path(__file__).resolve().parents[2] / "generation_models"
        if gen.is_dir() and str(gen) not in sys.path:
            sys.path.insert(0, str(gen))
        from localgen.attention_backend import flash_attn_import_error

        return flash_attn_import_error()
    except Exception:  # noqa: BLE001
        return None


def _flash_attn_import_ok() -> bool:
    try:
        gen = Path(__file__).resolve().parents[2] / "generation_models"
        if gen.is_dir() and str(gen) not in sys.path:
            sys.path.insert(0, str(gen))
        from localgen.attention_backend import flash_attn_installed

        return flash_attn_installed()
    except Exception:  # noqa: BLE001
        return False


def _torch_base_version() -> str | None:
    try:
        import torch

        return torch.__version__.split("+")[0]
    except ImportError:
        return None


def _torch_matches_flash_stack() -> bool:
    base = _torch_base_version()
    return base == PINNED_CUDA_TORCH


def _existing_cuda_torch_ok() -> bool:
    """
    True when the active venv already has a CUDA PyTorch that can drive diffusion.

    Do **not** downgrade a working cu130 build (e.g. torch 2.11+cu130 on RTX 50xx / sm_120)
    to cu128 for flash-attn wheels — that mismatch can make diffusion ~100× slower while
    still reporting ``device=cuda:0``.
    """
    try:
        import torch
    except ImportError:
        return False
    if not torch.cuda.is_available():
        return False
    ver = torch.__version__.lower()
    if "+cpu" in ver:
        return False
    cuda_tag = ""
    if "+cu" in ver:
        cuda_tag = ver.split("+cu", 1)[1].split("+", 1)[0]
    elif torch.version.cuda:
        cuda_tag = (torch.version.cuda or "").replace(".", "")[:3]
    if not cuda_tag:
        return False
    try:
        major, minor = torch.cuda.get_device_capability(0)
    except Exception:  # noqa: BLE001
        major, minor = 0, 0
    # Blackwell (sm_120): cu128 wheels are a known bad combo — keep cu130+ only.
    if major >= 12 and cuda_tag in ("128", "126", "124"):
        return False
    if sys.platform == "win32" and cuda_tag in ("130", "131"):
        if not _torch_matches_flash_stack():
            return False
    return True


def _purge_stale_flash_attn_wheels(dirs: list[Path]) -> None:
    """Drop cached wheels that cannot match the active torch/CUDA (common after upgrades)."""
    installed = _installed_torch_cuda()
    if not installed:
        return
    tv, cuda_short = installed
    for d in dirs:
        if not d.is_dir():
            continue
        for whl in list(d.glob("flash_attn*.whl")):
            name = whl.name
            lower = name.lower()
            if cuda_short == "130" and "cu128" in lower:
                whl.unlink(missing_ok=True)
                continue
            if _is_blackwell_sm120_wheel(name):
                whl.unlink(missing_ok=True)
                continue
            if name in {n for n, _ in _flash_attn_wheel_candidates()}:
                continue
            if _wheel_matches_torch(name, tv, cuda_short):
                continue
            whl.unlink(missing_ok=True)


def _find_bundled_wheel(dirs: list[Path]) -> Path | None:
    """Pick a cached wheel using the same priority order as network candidates."""
    candidate_names = [name for name, _url in _flash_attn_wheel_candidates()]
    for d in dirs:
        if not d.is_dir():
            continue
        for name in candidate_names:
            exact = d / name
            if exact.is_file():
                return exact
        installed = _installed_torch_cuda()
        if not installed:
            continue
        tv, cuda_short = installed
        by_name = {p.name: p for p in d.glob("flash_attn*.whl") if p.is_file()}
        for name in candidate_names:
            whl = by_name.get(name)
            if whl is not None and _wheel_matches_torch(name, tv, cuda_short):
                return whl
    return None


def _pip_uninstall_flash_attn() -> None:
    subprocess.run(
        [sys.executable, "-m", "pip", "uninstall", "-y", "flash-attn"],
        capture_output=True,
        text=True,
    )


def _ensure_flash_attn_runtime_deps() -> bool:
    """flash-attn wheels are installed with ``--no-deps``; einops is required at import."""
    ok = _pip_install(["einops"])
    if sys.platform == "win32":
        # Optional: cuDNN/cuBLAS bins help ``flash_attn_2_cuda`` resolve DLLs (torch/lib alone is not always enough).
        _pip_install(["--only-binary", ":all:", "nvidia-cudnn-cu13"])
    return ok


def nvidia_gpu_detected() -> bool:
    if sys.platform == "win32":
        try:
            r = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "Name"],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            text = ((r.stdout or "") + (r.stderr or "")).lower()
            if "nvidia" in text:
                return True
            if "amd" in text or "radeon" in text or "intel" in text:
                return False
        except Exception:  # noqa: BLE001
            pass
    if os.environ.get("OMEGA_FORCE_CUDA_TORCH", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    return True


def install_cpu_torch() -> bool:
    print("install_gpu_extras: installing CPU PyTorch (image/TTS on CPU or DirectML)…", flush=True)
    ok = _pip_install(["torch", "torchvision", "torchaudio"])
    if ok and sys.platform == "win32" and not nvidia_gpu_detected():
        print("install_gpu_extras: trying optional torch-directml for AMD/Intel GPU…", flush=True)
        _pip_install(["torch-directml"])
    return ok


def _cuda_torch_usable() -> bool:
    try:
        import torch

        if not torch.cuda.is_available():
            return False
        torch.zeros(1, device="cuda")
        torch.cuda.synchronize()
        return True
    except Exception:  # noqa: BLE001
        return False


def _replace_cuda_torch_with_cpu() -> bool:
    print("install_gpu_extras: replacing CUDA PyTorch with CPU build for this GPU…", flush=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio"],
        check=False,
    )
    return install_cpu_torch()


def install_cuda_torch(*, pin_windows: str | None = None) -> bool:
    if sys.platform == "darwin":
        print("install_gpu_extras: macOS uses CPU/MPS torch; skipping CUDA torch", flush=True)
        return True
    if sys.platform == "win32" and not nvidia_gpu_detected():
        print(
            "install_gpu_extras: no NVIDIA GPU detected — skipping CUDA PyTorch "
            "(Vulkan Omega builds use AMD GPU for chat only)",
            flush=True,
        )
        try:
            import torch

            if "+cu" in str(torch.__version__).lower():
                return _replace_cuda_torch_with_cpu()
        except Exception:  # noqa: BLE001
            pass
        return install_cpu_torch()
    pin = (pin_windows or PINNED_CUDA_TORCH).strip()
    index = "https://download.pytorch.org/whl/cu130"
    if _existing_cuda_torch_ok() and _torch_matches_flash_stack():
        import torch

        cap = torch.cuda.get_device_capability(0)
        print(
            f"install_gpu_extras: keeping existing torch {torch.__version__} "
            f"(CUDA {torch.version.cuda or '?'}, capability {cap[0]}.{cap[1]})",
            flush=True,
        )
        return True
    base = _torch_base_version()
    if base and base != pin:
        print(
            f"install_gpu_extras: torch {base} does not match flash-attn wheel (need {pin}) — reinstalling…",
            flush=True,
        )
    else:
        print(f"install_gpu_extras: installing CUDA PyTorch {pin} (cu130 index)…", flush=True)
    return _pip_install(
        [
            "--no-cache-dir",
            f"torch=={pin}+cu130",
            "torchvision==0.26.0+cu130",
            "torchaudio",
            "--index-url",
            index,
        ]
    )


def _download_flash_attn_wheel(dest: Path) -> Path | None:
    dest.mkdir(parents=True, exist_ok=True)
    candidates = _flash_attn_wheel_candidates()
    if not candidates:
        print("install_gpu_extras: cannot resolve flash-attn wheel candidates", flush=True)
        return None

    for name, url in candidates:
        existing = dest / name
        if existing.is_file():
            return existing
        print(f"bundle_flash_attn: trying {name}...", flush=True)
        r = subprocess.run(
            [sys.executable, "-m", "pip", "download", "-q", "--no-deps", "-d", str(dest), url],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            if r.stderr:
                print(r.stderr.strip(), file=sys.stderr, flush=True)
            continue
        if (dest / name).is_file():
            return dest / name
        for whl in dest.glob("flash_attn*.whl"):
            if whl.name == name or name in whl.name:
                return whl
    return None


def repair_flash_attn_mismatch() -> bool:
    """Remove a wrong CUDA/torch flash-attn wheel and install one that matches the venv."""
    if _flash_attn_import_ok() and _torch_matches_flash_stack():
        print("install_gpu_extras: flash-attn already loads", flush=True)
        return True
    if not install_cuda_torch():
        print("install_gpu_extras: could not install pinned CUDA torch", file=sys.stderr, flush=True)
        return False
    if not _torch_matches_flash_stack():
        print(
            f"install_gpu_extras: torch must be {PINNED_CUDA_TORCH}+cu130 before flash-attn",
            file=sys.stderr,
            flush=True,
        )
        return False
    try:
        import importlib.util

        if importlib.util.find_spec("flash_attn") is not None:
            print(
                "install_gpu_extras: removing mismatched flash-attn (wrong cu/torch wheel)…",
                flush=True,
            )
            _pip_uninstall_flash_attn()
    except Exception:  # noqa: BLE001
        pass
    return install_flash_attn()


def install_flash_attn(*, search_dirs: list[Path] | None = None) -> bool:
    if sys.platform == "darwin":
        print("install_gpu_extras: no prebuilt flash-attn wheel for macOS", flush=True)
        return False

    dirs = list(search_dirs or [])
    for d in _prebuilt_wheels_search_dirs():
        if d not in dirs:
            dirs.append(d)
    _purge_stale_flash_attn_wheels(dirs)

    if not _flash_attn_import_ok():
        try:
            import importlib.util

            if importlib.util.find_spec("flash_attn") is not None:
                print(
                    "install_gpu_extras: flash-attn package present but CUDA DLL failed — reinstalling…",
                    flush=True,
                )
                _pip_uninstall_flash_attn()
        except Exception:  # noqa: BLE001
            pass

    def _try_wheel(label: str, target: str) -> bool:
        if not _pip_install([target]):
            return False
        _ensure_flash_attn_runtime_deps()
        if _flash_attn_import_ok():
            print(f"install_gpu_extras: flash-attn ready ({label})", flush=True)
            return True
        err = _flash_attn_last_error()
        print(
            f"install_gpu_extras: {label} installed but CUDA extension failed to load"
            + (f" ({err})" if err else "")
            + " — trying next wheel…",
            flush=True,
        )
        _pip_uninstall_flash_attn()
        return False

    wheel = _find_bundled_wheel(dirs)
    if wheel is not None:
        print(f"install_gpu_extras: installing bundled flash-attn ({wheel.name})...", flush=True)
        if _try_wheel("bundled", str(wheel)):
            return True

    candidates = _flash_attn_wheel_candidates()
    for name, url in candidates:
        print(f"install_gpu_extras: trying {name}...", flush=True)
        if _try_wheel("network", url):
            return True

    print("install_gpu_extras: no matching flash-attn wheel for this torch/python/platform", flush=True)
    return False


def bundle_flash_attn_wheel(dest: Path) -> bool:
    """Download the matching flash-attn wheel into dest for installer packaging."""
    if sys.platform == "darwin":
        print("bundle_flash_attn: skipped on macOS (no CUDA flash-attn wheel)", flush=True)
        return False

    existing = _find_bundled_wheel([dest])
    if existing is not None:
        print(f"bundle_flash_attn: already present ({existing.name})", flush=True)
        return True

    wheel = _download_flash_attn_wheel(dest)
    if wheel is not None:
        print(f"bundle_flash_attn: saved {wheel.name}", flush=True)
        return True

    print(
        "bundle_flash_attn: no published wheel matched this Python/torch/CUDA "
        "(Content Studio will use PyTorch SDPA on GPU)",
        flush=True,
    )
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Install CUDA torch + flash-attn for Content Studio")
    parser.add_argument("tools_root", nargs="?", default=None, help="Omega tools dir (reserved)")
    parser.add_argument(
        "--bundle-wheels",
        "--download-wheels",
        type=Path,
        metavar="DIR",
        dest="bundle_wheels",
        help="Download flash-attn wheel into DIR (post-install cache; not shipped in installer)",
    )
    parser.add_argument(
        "--skip-torch",
        action="store_true",
        help="Assume CUDA torch is already installed (build pipeline)",
    )
    args = parser.parse_args()

    if args.bundle_wheels is not None:
        if not args.skip_torch:
            pin = WINDOWS_BUNDLE_TORCH if sys.platform == "win32" else None
            install_cuda_torch(pin_windows=pin)
        return 0 if bundle_flash_attn_wheel(args.bundle_wheels.resolve()) else 1

    if not install_cuda_torch():
        print("install_gpu_extras: PyTorch install failed", file=sys.stderr, flush=True)
        return 1

    if sys.platform == "darwin":
        return 0

    if not nvidia_gpu_detected():
        print(
            "install_gpu_extras: non-NVIDIA GPU — skipping CUDA flash-attn; "
            "image generation uses CPU or DirectML if torch-directml installed",
            flush=True,
        )
        return 0

    if not install_flash_attn():
        repair_flash_attn_mismatch()

    if not _existing_cuda_torch_ok() or not _torch_matches_flash_stack():
        print(
            "install_gpu_extras: WARNING — CUDA PyTorch still missing or mismatched for this GPU. "
            f"Expected torch=={PINNED_CUDA_TORCH}+cu130. "
            "Re-run Content Studio setup or: python scripts/repair_flash_attn.py",
            file=sys.stderr,
            flush=True,
        )
        return 1

    if not _flash_attn_import_ok():
        print(
            "install_gpu_extras: flash-attn not installed (PyTorch SDPA on GPU — slower steps). "
            "If you had FA before, run: python scripts/repair_flash_attn.py",
            flush=True,
        )
        print(
            "install_gpu_extras: WARNING — flash-attn wheel installed but CUDA extension failed to load.",
            file=sys.stderr,
            flush=True,
        )
        # CUDA torch is OK — do not fail the whole Content Studio setup (SDPA fallback works).
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
