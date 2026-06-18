"""Shared scene ordering for TTS, images, and ffmpeg."""

from __future__ import annotations

from typing import Any


def sorted_script_scenes(script_content: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Return script scenes in render order with ``scene_number`` renumbered 1..N.

    Renumbering keeps ``scene_XX.wav`` / ``scene_XX.png`` aligned even when the LLM
    omits or duplicates ``scene_number`` fields.
    """
    raw = [s for s in (script_content.get("scenes") or []) if isinstance(s, dict)]
    ordered = sorted(
        enumerate(raw),
        key=lambda pair: int(pair[1].get("scene_number") or pair[0] + 1),
    )
    out: list[dict[str, Any]] = []
    for i, sc in enumerate(sc for _, sc in ordered):
        row = dict(sc)
        row["scene_number"] = i + 1
        out.append(row)
    return out
