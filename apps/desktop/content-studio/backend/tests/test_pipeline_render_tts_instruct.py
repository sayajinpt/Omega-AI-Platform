"""`run_local_production_bundle` must derive a sensible TTS instruct from the brief when
the project's ``narration_tone`` is empty, so short-form videos get fast pacing by default."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("localgen")

from app.services import pipeline_render as pr  # noqa: E402


class _NullDB:
    def add(self, *_a: Any, **_kw: Any) -> None: ...
    def commit(self) -> None: ...


def _stub_image_and_ffmpeg(monkeypatch: pytest.MonkeyPatch, mp4_path: Path) -> None:
    """Skip the SD3 / ffmpeg / DB-persist parts — this test is about the TTS instruct wire-up."""
    monkeypatch.setattr(pr, "run_sd3_images_for_job", lambda *a, **kw: "images: ok")
    monkeypatch.setattr(pr, "run_subtitle_frames_for_job", lambda *a, **kw: "subtitles: ok")
    monkeypatch.setattr(pr, "assemble_final_mp4", lambda *a, **kw: mp4_path)
    monkeypatch.setattr(pr, "ffprobe_duration_seconds", lambda *a, **kw: 30)
    monkeypatch.setattr(pr, "set_pipeline_phase", lambda *a, **kw: None)

    # Skip the DB-row persist (no SQLAlchemy session in test).
    monkeypatch.setattr(pr, "Video", lambda **kw: object())


def test_short_form_with_no_user_narration_tone_gets_fast_archetype_instruct(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Shorts + empty narration_tone → archetype derives a 'fast / high-energy' instruct."""
    mp4 = tmp_path / "final.mp4"
    mp4.parent.mkdir(parents=True, exist_ok=True)
    mp4.write_bytes(b"")
    _stub_image_and_ffmpeg(monkeypatch, mp4)

    seen: dict[str, Any] = {}

    def fake_tts(db: Any, **kwargs: Any) -> str:
        seen.update(kwargs)
        return "Synthesized 5/5 scene WAV file(s)"

    monkeypatch.setattr(pr, "run_local_tts_for_job", fake_tts)
    monkeypatch.setattr(pr.settings, "storage_path", str(tmp_path), raising=False)

    brief_json = {"video_type": "youtube_shorts_vertical", "target_duration_seconds": 30}
    summary, _ = pr.run_local_production_bundle(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content={"scenes": [{"scene_number": 1, "duration_seconds": 30, "narration_text": "x"}]},
        brief_json=brief_json,
        payload={},
        tts_instruct=None,
    )

    instr = seen.get("instruct")
    assert isinstance(instr, str) and instr.strip(), "TTS instruct must be auto-derived, not blank"
    assert "fast" in instr.lower()
    assert "do not slow down at scene boundaries" in instr.lower()


def test_user_provided_narration_tone_overrides_archetype_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mp4 = tmp_path / "final.mp4"
    mp4.parent.mkdir(parents=True, exist_ok=True)
    mp4.write_bytes(b"")
    _stub_image_and_ffmpeg(monkeypatch, mp4)

    seen: dict[str, Any] = {}

    def fake_tts(db: Any, **kwargs: Any) -> str:
        seen.update(kwargs)
        return "Synthesized 1/1 scene WAV file(s)"

    monkeypatch.setattr(pr, "run_local_tts_for_job", fake_tts)
    monkeypatch.setattr(pr.settings, "storage_path", str(tmp_path), raising=False)

    brief_json = {"video_type": "youtube_shorts_vertical", "target_duration_seconds": 30}
    pr.run_local_production_bundle(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content={"scenes": [{"scene_number": 1, "duration_seconds": 30, "narration_text": "x"}]},
        brief_json=brief_json,
        payload={},
        tts_instruct="Slow, sleepy bedtime story voice",
    )

    assert seen.get("instruct") == "Slow, sleepy bedtime story voice"
