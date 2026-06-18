"""No-image mode renderer: produces PNG with the narration text drawn on a flat background."""

from __future__ import annotations

from pathlib import Path

import pytest

PIL = pytest.importorskip("PIL")

from app.services.subtitle_frame_renderer import (  # noqa: E402
    _dims_from_aspect,
    _theme_colors,
    _wrap_text_to_width,
    render_subtitle_frame,
)


def test_dims_from_aspect_vertical_and_landscape() -> None:
    assert _dims_from_aspect("9:16") == (720, 1280)
    assert _dims_from_aspect("16:9") == (1280, 720)
    assert _dims_from_aspect("") == (1280, 720)


def test_theme_colors_returns_three_rgb_tuples() -> None:
    bg, fg, accent = _theme_colors("dark")
    assert isinstance(bg, tuple) and len(bg) == 3
    assert isinstance(fg, tuple) and len(fg) == 3
    assert isinstance(accent, tuple) and len(accent) == 3
    for v in (*bg, *fg, *accent):
        assert 0 <= v <= 255


def test_theme_colors_falls_back_to_dark_on_unknown() -> None:
    assert _theme_colors("rainbow") == _theme_colors("dark")


def test_render_subtitle_frame_writes_png(tmp_path: Path) -> None:
    out = tmp_path / "scene_01.png"
    render_subtitle_frame(
        out,
        width=720,
        height=1280,
        text="In 1947, something fell from the New Mexico sky.",
        scene_number=1,
        theme="dark",
    )
    assert out.is_file()
    from PIL import Image

    with Image.open(out) as img:
        assert img.size == (720, 1280)
        assert img.mode == "RGB"


def test_wrap_text_handles_long_lines() -> None:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (400, 200), color=(0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = PIL.ImageFont.load_default()
    long_text = "this text should wrap onto multiple lines because the width is small"
    lines = _wrap_text_to_width(draw, long_text, font, 120)
    assert len(lines) > 1


def test_render_subtitle_frame_uses_fallback_for_empty_narration(tmp_path: Path) -> None:
    out = tmp_path / "scene_07.png"
    render_subtitle_frame(out, width=1280, height=720, text="   ", scene_number=7, theme="cool")
    assert out.is_file()
