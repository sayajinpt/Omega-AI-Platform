"""TTS `instruct` (Qwen3 voice-direction parameter) is derived from the format archetype
so short-form videos automatically get fast / high-energy pacing — the user's explicit
``narration_tone`` always wins when set."""

from __future__ import annotations

from app.models.enums import VideoType
from app.services.narration_tone_presets import preset_by_key
from app.services.video_brief import VideoBrief, tts_instruct_from_brief_dict
from app.services.video_type_profile import (
    SHORTS_HOOK_DRIVEN,
    CINEMATIC_3ACT,
    format_archetype_for,
)


def _build_brief(
    *,
    video_type: VideoType,
    seconds: int,
    narration_tone: str | None = None,
) -> VideoBrief:
    return VideoBrief(
        project_id="p1",
        title="t",
        theme="alien conspiracy theories",
        video_type=video_type,
        target_duration_seconds=seconds,
        aspect_ratio="9:16" if video_type == VideoType.youtube_shorts_vertical else "16:9",
        pacing_and_structure_notes="x",
        scene_durations_seconds=[seconds],
        narration_tone=narration_tone,
    )


def test_shorts_archetype_tts_instruction_is_fast_and_high_energy() -> None:
    instr = SHORTS_HOOK_DRIVEN.tts_instruction()
    assert "fast" in instr.lower()
    assert "high-energy" in instr.lower()
    # Voice description must be embedded.
    assert "urgent" in instr.lower() or "confident" in instr.lower()
    # Pacing-consistency clause — addresses the user's "different tone per scene" complaint.
    assert "do not slow down at scene boundaries" in instr.lower()


def test_cinematic_archetype_tts_instruction_is_measured_not_fast() -> None:
    instr = CINEMATIC_3ACT.tts_instruction()
    assert "measured" in instr.lower() or "intimate" in instr.lower()
    assert "fast" not in instr.lower()


def test_brief_effective_tts_instruct_uses_archetype_default_when_tone_blank() -> None:
    b = _build_brief(video_type=VideoType.youtube_shorts_vertical, seconds=30, narration_tone="")
    out = b.effective_tts_instruct()
    assert out == SHORTS_HOOK_DRIVEN.tts_instruction()


def test_brief_effective_tts_instruct_prefers_user_override() -> None:
    b = _build_brief(
        video_type=VideoType.youtube_shorts_vertical,
        seconds=30,
        narration_tone="Slow, sleepy bedtime story voice",
    )
    out = b.effective_tts_instruct()
    assert out == "Slow, sleepy bedtime story voice"


def test_tts_instruct_from_brief_dict_uses_override_when_present() -> None:
    payload = {"video_type": "youtube_shorts_vertical", "target_duration_seconds": 30}
    out = tts_instruct_from_brief_dict(payload, override="Authoritative documentary narration")
    assert out == "Authoritative documentary narration"


def test_tts_instruct_from_brief_dict_falls_back_to_archetype_for_shorts() -> None:
    payload = {"video_type": "youtube_shorts_vertical", "target_duration_seconds": 30}
    out = tts_instruct_from_brief_dict(payload, override=None)
    assert "fast" in out.lower()
    assert "do not slow down at scene boundaries" in out.lower()


def test_tts_instruct_from_brief_dict_falls_back_to_archetype_for_long_form() -> None:
    payload = {"video_type": "documentary_voiceover", "target_duration_seconds": 20 * 60}
    out = tts_instruct_from_brief_dict(payload, override=None)
    # 20-minute documentary picks a measured / intimate archetype, NOT short-form.
    assert "fast" not in out.lower()


def test_tts_instruct_from_brief_dict_tolerates_garbage_input() -> None:
    out = tts_instruct_from_brief_dict({}, override="")
    assert isinstance(out, str)
    assert out.strip() != ""


def test_tts_instruct_expands_chat_chip_conspiracy_to_full_preset() -> None:
    payload = {"video_type": "youtube_shorts_vertical", "target_duration_seconds": 30}
    out = tts_instruct_from_brief_dict(payload, override="conspiracy")
    expected = preset_by_key("conspiratorial_whisper")
    assert expected is not None
    assert out == expected.instruct.strip()
    assert "conspiratorial" in out.lower()


def test_archetype_picker_matches_what_brief_uses() -> None:
    """``effective_tts_instruct`` must call the same archetype that ``format_archetype`` returns."""
    b = _build_brief(video_type=VideoType.theory_narrative_engaging, seconds=8 * 60)
    expected = format_archetype_for(VideoType.theory_narrative_engaging, 8 * 60).tts_instruction()
    assert b.effective_tts_instruct() == expected
