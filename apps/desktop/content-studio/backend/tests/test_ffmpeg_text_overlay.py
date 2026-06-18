from pathlib import Path

from app.services.ffmpeg_text_overlay import (
    overlay_caption_for_scene,
    video_filter_with_caption,
    write_caption_textfile,
)


def test_overlay_from_text_overlays() -> None:
    cap = overlay_caption_for_scene(
        {
            "narration_text": "Long narration that should not be used when overlays exist.",
            "text_overlays": [{"text": "Built ~2560 BCE", "placement": "lower_third"}],
        }
    )
    assert cap == "Built ~2560 BCE"


def test_overlay_fallback_from_narration() -> None:
    cap = overlay_caption_for_scene(
        {"narration_text": "The Great Pyramid of Giza is the oldest wonder.", "text_overlays": []}
    )
    assert "Great Pyramid" in cap


def test_video_filter_includes_drawtext() -> None:
    vf = video_filter_with_caption(
        "scale=720:1280", "Giza facts", width=720, height=1280, fontfile="caption_font.ttf"
    )
    assert "drawtext=fontfile=caption_font.ttf:" in vf
    assert "Giza facts" in vf
    assert "text_w=" not in vf
    assert "fix_bounds=" not in vf
    assert "x=max(" in vf and "(w-text_w)/2)" in vf
    assert "C:" not in vf
    assert "C\\:" not in vf


def test_caption_textfile_wraps_long_lines(tmp_path: Path) -> None:
    long_caption = " ".join(["word"] * 40)
    name = write_caption_textfile(tmp_path, 1, long_caption, width=720, fontsize=40)
    assert name == "caption_01.txt"
    body = (tmp_path / name).read_text(encoding="utf-8")
    assert "\n" in body
    for line in body.splitlines():
        assert len(line) <= 48


def test_video_filter_skips_drawtext_without_font() -> None:
    vf = video_filter_with_caption("scale=720:1280", "Giza facts", width=720, height=1280)
    assert "drawtext=" not in vf


def test_caption_textfile_handles_apostrophes_and_commas(tmp_path: Path) -> None:
    name = write_caption_textfile(
        tmp_path, 3, "Discover Lisbon's monasteries, and pasteis de nata", width=720, fontsize=40
    )
    assert name == "caption_03.txt"
    body = (tmp_path / name).read_text(encoding="utf-8")
    assert "Lisbon's" in body
    assert "monasteries" in body
    vf = video_filter_with_caption(
        "scale=720:1280",
        "",
        width=720,
        height=1280,
        fontfile="caption_font.ttf",
        textfile=name,
    )
    assert "textfile=caption_03.txt" in vf
    assert "text='" not in vf
