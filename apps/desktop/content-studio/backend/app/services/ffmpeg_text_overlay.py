"""Burn scene text_overlays (TikTok-style captions) into ffmpeg video filters."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any


def _escape_drawtext(text: str) -> str:
    t = text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'").replace("%", "\\%")
    t = t.replace(",", "\\,")
    return re.sub(r"[\r\n]+", " ", t).strip()


def _wrap_caption_lines(caption: str, *, width: int, fontsize: int, max_lines: int = 4) -> str:
    """Pre-wrap caption text — packaged ffmpeg drawtext lacks ``text_w`` / ``fix_bounds`` options."""
    margin_x = max(56, int(width * 0.08))
    max_px = max(120, width - 2 * margin_x)
    chars_per_line = max(8, int(max_px / max(1, fontsize * 0.52)))
    words = re.sub(r"[\r\n]+", " ", (caption or "").strip()).split()
    if not words:
        return ""
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        trial = " ".join(current + [word]) if current else word
        if len(trial) <= chars_per_line:
            current.append(word)
            continue
        if current:
            lines.append(" ".join(current))
        current = [word]
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(" ".join(current))
    if len(lines) == max_lines:
        used = sum(len(line.split()) for line in lines)
        if used < len(words) and lines:
            last = lines[-1]
            if len(last) > chars_per_line - 1:
                last = last[: max(0, chars_per_line - 1)]
            lines[-1] = (last.rstrip() + "…") if last else "…"
    return "\n".join(lines)


def write_caption_textfile(
    segments_dir: Path,
    scene_number: int,
    caption: str,
    *,
    width: int,
    fontsize: int,
) -> str | None:
    """Write UTF-8 caption text for ffmpeg ``drawtext=textfile=`` (avoids quote/comma filter breakage)."""
    text = _wrap_caption_lines(caption, width=width, fontsize=fontsize)
    if not text:
        return None
    name = f"caption_{int(scene_number):02d}.txt"
    (segments_dir / name).write_text(text, encoding="utf-8")
    return name


def overlay_caption_for_scene(scene: dict[str, Any]) -> str:
    """On-screen line: text_overlays first, else a short punch from narration_text."""
    parts: list[str] = []
    raw = scene.get("text_overlays")
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                t = str(item.get("text") or "").strip()
            else:
                t = str(item).strip()
            if t:
                parts.append(t)
    if parts:
        return " · ".join(parts)[:140]

    narr = str(scene.get("narration_text") or "").strip()
    if not narr:
        return ""
    sentence = re.split(r"[.!?]\s+", narr, maxsplit=1)[0] or narr
    words = sentence.split()
    return " ".join(words[:10])[:120]


def video_filter_with_caption(
    base_vf: str,
    caption: str,
    *,
    width: int,
    height: int,
    fontfile: str | None = None,
    textfile: str | None = None,
) -> str:
    """Append drawtext to scale/pad chain for vertical short captions."""
    if not fontfile:
        return base_vf
    text = _escape_drawtext(caption)
    if not textfile and not text:
        return base_vf
    size = max(28, min(56, height // 18))
    border = max(2, size // 14)
    margin_x = max(56, int(width * 0.08))
    # Prefer textfile= — inline text='…' breaks when captions contain apostrophes (Lisbon's →
    # ffmpeg treats the rest as new filters, e.g. No such filter: 'monasteries').
    # ``text_w`` in x= is an expression variable (glyph width), not a drawtext option.
    text_src = f"textfile={textfile}" if textfile else f"text='{text}'"
    dt = (
        f"drawtext=fontfile={fontfile}:{text_src}:fontsize={size}:fontcolor=white:"
        f"borderw={border}:bordercolor=black@0.9:"
        f"x=max({margin_x}\\,(w-text_w)/2):y=h-h/5-text_h"
    )
    return f"{base_vf},{dt}"
