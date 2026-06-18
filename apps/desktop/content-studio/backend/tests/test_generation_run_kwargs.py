"""Phase 3 — probe → pipeline kwargs."""

from __future__ import annotations

from app.services.generation_run_kwargs import (
    apply_narration_speed_to_instruct,
    build_image_run_kwargs,
    build_tts_run_kwargs,
)


def test_narration_speed_appends_instruct() -> None:
    out = apply_narration_speed_to_instruct("Warm tone.", "fast")
    assert out is not None
    assert "Warm tone." in out
    assert "fast" in out.lower()


def test_build_tts_run_kwargs_qwen_catalog() -> None:
    kw = build_tts_run_kwargs(
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        speaker="Vivian",
        language="English",
        instruct="Calm documentary.",
        voice_gender="female",
        brief_json={"narration_speed": "slow"},
    )
    assert kw["backend_supported"] is True
    assert kw["speaker"] == "Vivian"
    assert kw["language"] == "English"
    assert kw["instruct"] is not None
    assert "slow" in kw["instruct"].lower() or "slower" in kw["instruct"].lower()
    assert kw["generation_mode"] == "custom_voice"


def test_build_tts_run_kwargs_unknown_repo() -> None:
    kw = build_tts_run_kwargs("acme/TotallyUnknownVoice-v1")
    assert kw["backend_supported"] is False
    assert kw["unsupported_reason"]


def test_build_image_run_kwargs_zimage_zero_cfg() -> None:
    kw = build_image_run_kwargs("Tongyi-MAI/Z-Image-Turbo", image_style="cinematic_film")
    assert kw["family"] == "zimage"
    assert kw["guidance_scale"] == 0.0
    assert kw["supports_negative_prompt"] is False
    assert kw["style_preset"] == "cinematic_film"
