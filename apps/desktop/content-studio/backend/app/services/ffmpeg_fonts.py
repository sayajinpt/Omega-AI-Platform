"""Resolve a system TTF for ffmpeg drawtext (avoids Fontconfig on Windows)."""

from __future__ import annotations

import os
from pathlib import Path

_FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/SegoeUIBold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def resolve_system_font_path() -> Path | None:
    windir = os.environ.get("WINDIR", "")
    if windir:
        fonts_dir = Path(windir) / "Fonts"
        for name in ("segoeuib.ttf", "SegoeUIBold.ttf", "arialbd.ttf", "arial.ttf"):
            p = fonts_dir / name
            if p.is_file():
                return p
    for raw in _FONT_CANDIDATES:
        p = Path(raw)
        if p.is_file():
            return p
    return None


def ffmpeg_drawtext_fontfile_clause(font_path: Path) -> str:
    """drawtext filter prefix: fontfile='C\\:/Windows/Fonts/arial.ttf'"""
    escaped = font_path.as_posix().replace(":", "\\:")
    return f"fontfile='{escaped}':"
