"""Install SoX CLI for Content Studio on Windows.

The Python ``sox`` package (pulled in with librosa / local media) only wraps the
native ``sox`` executable. Omega expects it at::

    <tools_root>/sox/sox.exe

Packaging (build machine): ``python install_sox.py --bundle-to ../../tools/sox``
First-run setup:           ``python install_sox.py <tools_root>``
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SOX_VERSION = "14.4.2"
SOX_ZIP_URL = (
    f"https://downloads.sourceforge.net/project/sox/sox/{SOX_VERSION}/"
    f"sox-{SOX_VERSION}-win32.zip"
)


def _find_sox_dir(root: Path) -> Path | None:
    if not root.is_dir():
        return None
    direct = root / "sox.exe"
    if direct.is_file():
        return root
    nested = root / f"sox-{SOX_VERSION}" / "sox.exe"
    if nested.is_file():
        return nested.parent
    for child in root.iterdir():
        if child.is_dir() and (child / "sox.exe").is_file():
            return child
    return None


def _bundle_sources() -> list[Path]:
    roots: list[Path] = []
    seen: set[Path] = set()

    def add(p: Path) -> None:
        resolved = p.expanduser().resolve()
        if resolved in seen:
            return
        seen.add(resolved)
        roots.append(resolved)

    # content-studio/tools/sox (shipped in Omega installer extraResources)
    add(Path(__file__).resolve().parents[2] / "tools" / "sox")
    raw = os.environ.get("OMEGA_CONTENT_STUDIO_PATH", "").strip()
    if raw:
        add(Path(raw).expanduser() / "tools" / "sox")
    return roots


def _copy_tree(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)


def _install_from_zip(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="omega-sox-") as tmp:
        tmp_path = Path(tmp)
        zip_path = tmp_path / "sox.zip"
        print(f"install_sox: downloading SoX {SOX_VERSION} for Windows…", flush=True)
        urllib.request.urlretrieve(SOX_ZIP_URL, zip_path)
        extract_root = tmp_path / "extract"
        extract_root.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_root)
        found = _find_sox_dir(extract_root)
        if found is None:
            raise RuntimeError("sox.exe not found in downloaded archive")
        _copy_tree(found, dest)
    print(f"install_sox: installed {dest / 'sox.exe'}", flush=True)


def _try_bundle_copy(dest: Path) -> bool:
    for src_root in _bundle_sources():
        found = _find_sox_dir(src_root)
        if found is None:
            continue
        print(f"install_sox: copying bundled SoX from {found}", flush=True)
        _copy_tree(found, dest)
        return True
    return False


def _sox_dest(tools_root: Path) -> Path:
    """``tools_root`` is Omega's tools dir; SoX lives in ``tools_root/sox``."""
    name = tools_root.name.lower()
    if name == "sox" or (tools_root / "sox.exe").is_file():
        return tools_root
    return tools_root / "sox"


def install_sox(tools_root: Path) -> bool:
    """Install into ``tools_root/sox`` (or ``tools_root`` when it is already the sox folder)."""
    dest = _sox_dest(tools_root)
    if _find_sox_dir(dest) is not None:
        print(f"install_sox: already present at {dest}", flush=True)
        return True
    if sys.platform != "win32":
        print("install_sox: skipped (Windows-only bundle; use system sox on PATH)", flush=True)
        return False
    if _try_bundle_copy(dest):
        return _find_sox_dir(dest) is not None
    try:
        _install_from_zip(dest)
    except Exception as exc:
        print(f"install_sox: download failed: {exc}", file=sys.stderr, flush=True)
        return False
    return _find_sox_dir(dest) is not None


def main() -> int:
    parser = argparse.ArgumentParser(description="Install SoX CLI for Content Studio")
    parser.add_argument(
        "tools_root",
        nargs="?",
        type=Path,
        help="Omega tools dir (e.g. ~/.omega/content-studio/tools)",
    )
    parser.add_argument(
        "--bundle-to",
        type=Path,
        metavar="DIR",
        help="Download SoX into DIR (content-studio/tools/sox — folder that will contain sox.exe)",
    )
    args = parser.parse_args()

    if args.bundle_to is not None:
        if sys.platform != "win32":
            print("install_sox: --bundle-to is only used on Windows builds", flush=True)
            return 0
        ok = install_sox(args.bundle_to.resolve())
        return 0 if ok else 1

    if args.tools_root is None:
        parser.error("tools_root is required unless --bundle-to is set")

    ok = install_sox(args.tools_root.resolve())
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
