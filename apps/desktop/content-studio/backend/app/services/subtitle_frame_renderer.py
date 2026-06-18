"""
Render per-scene PNG frames that show the narration text on a flat background.

Used when a project has ``no_image_mode=True``: the rendered video shows the spoken text
on screen (large, centered, word-wrapped) instead of an SD3-generated image. The audio
track is the TTS narration as usual.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import JobLog

_VALID_THEMES = ("dark", "light", "warm", "cool")


def _dims_from_aspect(aspect: str) -> tuple[int, int]:
    a = (aspect or "16:9").strip()
    if a in ("9:16", "vertical"):
        return 720, 1280
    return 1280, 720


def _theme_colors(theme: str) -> tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]:
    """Return (background, text, accent) RGB tuples."""
    t = (theme or "dark").strip().lower()
    if t not in _VALID_THEMES:
        t = "dark"
    if t == "light":
        return (245, 245, 247), (28, 30, 36), (210, 95, 30)
    if t == "warm":
        return (24, 18, 14), (245, 232, 200), (255, 168, 64)
    if t == "cool":
        return (12, 18, 32), (220, 232, 248), (96, 184, 255)
    return (16, 16, 20), (240, 240, 244), (140, 200, 255)


def _load_font(size: int):
    """Pick the largest readable system font available — PIL's default font is tiny."""
    from PIL import ImageFont

    from app.services.ffmpeg_fonts import resolve_system_font_path

    path = resolve_system_font_path()
    if path:
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            pass
    return ImageFont.load_default()


def _line_pixel_width(draw, line: str, font) -> float:
    bbox = draw.textbbox((0, 0), line, font=font)
    return float(bbox[2] - bbox[0])


def _wrap_text_to_width(draw, text: str, font, max_width_px: int) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines: list[str] = []
    cur = words[0]
    for w in words[1:]:
        candidate = cur + " " + w
        if _line_pixel_width(draw, candidate, font) <= max_width_px:
            cur = candidate
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def render_subtitle_frame(
    out_path: Path,
    *,
    width: int,
    height: int,
    text: str,
    scene_number: int,
    theme: str = "dark",
) -> None:
    """Write a PNG with the narration text wrapped, centered, on a flat themed background."""
    from PIL import Image, ImageDraw

    bg, fg, accent = _theme_colors(theme)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (width, height), color=bg)
    draw = ImageDraw.Draw(img)

    side_pad = max(56, int(width * 0.10))
    text_box_w = max(200, width - 2 * side_pad)

    target_size = int(min(height, width) * 0.075)
    target_size = max(28, min(target_size, 96))
    font = _load_font(target_size)

    body = (text or "").strip() or f"Scene {scene_number}"
    lines = _wrap_text_to_width(draw, body, font, text_box_w)
    while len(lines) > 8 and target_size > 28:
        target_size = int(target_size * 0.9)
        font = _load_font(target_size)
        lines = _wrap_text_to_width(draw, body, font, text_box_w)

    line_height = int(target_size * 1.32)
    total_h = line_height * len(lines)
    y0 = max(80, (height - total_h) // 2)

    accent_y = y0 - max(28, int(target_size * 0.55))
    accent_h = max(4, int(target_size * 0.10))
    accent_w = max(80, int(width * 0.10))
    accent_x = (width - accent_w) // 2
    draw.rectangle(
        (accent_x, accent_y, accent_x + accent_w, accent_y + accent_h),
        fill=accent,
    )

    for i, line in enumerate(lines):
        line_w = _line_pixel_width(draw, line, font)
        x = max(float(side_pad), (width - line_w) / 2.0)
        if x + line_w > width - side_pad:
            x = float(side_pad)
        y = y0 + i * line_height
        draw.text((x + 2, y + 2), line, fill=(0, 0, 0), font=font)
        draw.text((x, y), line, fill=fg, font=font)

    label = f"SCENE {scene_number:02d}"
    small = _load_font(max(16, int(target_size * 0.32)))
    lw = draw.textlength(label, font=small)
    draw.text((width - lw - 28, height - 48), label, fill=accent, font=small)

    img.save(out_path, format="PNG")


def run_subtitle_frames_for_job(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    theme: str = "dark",
) -> str:
    """Write ``images/scene_NN.png`` for each scene as a flat subtitle card. No SD3."""
    from app.config import settings

    scenes = script_content.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return "Subtitle frames: no scenes."

    aspect = str(brief_json.get("aspect_ratio") or "16:9")
    width, height = _dims_from_aspect(aspect)

    root = Path(settings.storage_path).expanduser().resolve()
    out_dir = root / project_id / job_id / "images"
    out_dir.mkdir(parents=True, exist_ok=True)

    for sc in scenes:
        if not isinstance(sc, dict):
            continue
        sn = int(sc.get("scene_number", 0))
        text = (sc.get("narration_text") or "").strip() or f"Scene {sn}"
        render_subtitle_frame(
            out_dir / f"scene_{sn:02d}.png",
            width=width,
            height=height,
            text=text,
            scene_number=sn,
            theme=theme,
        )

    db.add(
        JobLog(
            job_id=job_id,
            level="info",
            message=f"No-image mode: wrote {len(scenes)} subtitle frame PNG(s) → {out_dir}",
        )
    )
    db.commit()
    return f"Subtitle frames → {out_dir}"
