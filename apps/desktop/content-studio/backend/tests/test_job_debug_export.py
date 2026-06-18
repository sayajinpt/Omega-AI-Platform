from pathlib import Path

import pytest

from app.services.job_debug_export import write_pipeline_debug_bundle


def test_write_pipeline_debug_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.job_debug_export.settings.storage_path", str(tmp_path))
    brief = {
        "project_id": "p1",
        "title": "T",
        "theme": "th",
        "video_type": "youtube_shorts_vertical",
        "target_duration_seconds": 30,
        "aspect_ratio": "9:16",
        "scene_count": 1,
        "planned_total_seconds": 30,
        "scene_durations_seconds": [30],
        "tts_speaker": "Ryan",
    }
    script = {
        "title": "Hello",
        "description": "Desc",
        "scenes": [
            {
                "scene_number": 1,
                "duration_seconds": 30,
                "narration_text": "Say this",
                "image_prompt": "A sunset",
                "transition": "fade",
                "text_overlays": [],
            }
        ],
    }
    out = write_pipeline_debug_bundle(
        project_id="p1",
        job_id="j1",
        project_title="Hello",
        brief_json=brief,
        script_content=script,
        series_id="s1",
        mp4_relative="p1/j1/final.mp4",
        skip_local_media=False,
    )
    assert out is not None
    assert (tmp_path / "p1" / "j1" / "debug" / "script.txt").is_file()
    assert "Say this" in (tmp_path / "p1" / "j1" / "debug" / "script.txt").read_text(encoding="utf-8")
    assert "A sunset" in (tmp_path / "p1" / "j1" / "debug" / "image_prompts.txt").read_text(encoding="utf-8")
    assert (tmp_path / "p1" / "DEBUG_LATEST.txt").is_file()
