"""Runtime generation capability probes (model-agnostic)."""

from __future__ import annotations

from pathlib import Path

from app.services.generation_capabilities import probe_generation_capabilities


def test_probe_qwen_tts_catalog_repo() -> None:
    out = probe_generation_capabilities("tts", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    assert out["backend_supported"] is True
    assert out["family"] == "qwen3_tts_custom_voice"
    ids = {c["id"] for c in out["controls"]}
    assert "speaker" in ids
    assert "language" in ids
    assert "narration_speed" in ids
    assert "max_duration_seconds" in ids


def test_probe_unknown_tts_not_supported() -> None:
    out = probe_generation_capabilities("tts", "acme/TotallyUnknownVoice-v1")
    assert out["backend_supported"] is False
    assert out["family"] == "unknown_tts"
    assert out["unsupported_reason"]
    assert {c["id"] for c in out["controls"]} == {"max_duration_seconds"}


def test_probe_xtts_repo_without_package() -> None:
    out = probe_generation_capabilities("tts", "coqui/XTTS-v2")
    assert out["family"] == "xtts"
    assert out["backend_supported"] is False
    assert out["unsupported_reason"]


def test_probe_image_diffusers_on_disk(tmp_path: Path, monkeypatch) -> None:
    gen_root = tmp_path / "generation-models"
    pack = gen_root / "image" / "org__test-model"
    pack.mkdir(parents=True)
    (pack / "model_index.json").write_text('{"_class_name": "StableDiffusionXLPipeline"}', encoding="utf-8")

    monkeypatch.setattr(
        "app.services.generation_capabilities.get_models_root",
        lambda: gen_root,
    )

    out = probe_generation_capabilities("image", "org/test-model", gen_root=gen_root)
    assert out["on_disk"] is True
    assert out["backend_supported"] is True
    assert "negative_prompt" in {c["id"] for c in out["controls"]}
    assert out["constraints"]["supports_negative_prompt"] is True


def test_probe_zimage_catalog_constraints() -> None:
    out = probe_generation_capabilities("image", "Tongyi-MAI/Z-Image-Turbo")
    assert out["family"] == "zimage"
    assert out["constraints"]["supports_negative_prompt"] is False
    assert out["constraints"]["guidance_scale_fixed"] == 0.0
    ids = {c["id"] for c in out["controls"]}
    assert "negative_prompt" not in ids


def test_probe_video_ltx_catalog() -> None:
    out = probe_generation_capabilities("video", "Lightricks/LTX-Video-0.9.5")
    assert out["family"] == "ltx_video"
    ids = {c["id"] for c in out["controls"]}
    assert "num_frames" in ids
    assert "fps" in ids
    assert "decode_timestep" in ids
