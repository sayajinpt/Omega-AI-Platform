from pathlib import Path

from app.services.ffmpeg_compose import _ffmpeg_concat_line, ffprobe_has_audio_stream
from app.services.script_scenes import sorted_script_scenes


def test_sorted_script_scenes_orders_by_scene_number() -> None:
    script = {
        "scenes": [
            {"scene_number": 3, "narration_text": "c"},
            {"scene_number": 1, "narration_text": "a"},
            {"narration_text": "b"},
        ]
    }
    ordered = sorted_script_scenes(script)
    assert [s["scene_number"] for s in ordered] == [1, 2, 3]


def test_ffmpeg_concat_line_uses_forward_slashes(tmp_path: Path) -> None:
    p = tmp_path / "scene_01.mp4"
    p.write_bytes(b"x")
    line = _ffmpeg_concat_line(p)
    assert line.startswith("file '")
    assert "\\" not in line or "/" in line


def test_ffprobe_has_audio_stream_missing_file() -> None:
    assert ffprobe_has_audio_stream(Path("/nonexistent/file.mp4")) is False
