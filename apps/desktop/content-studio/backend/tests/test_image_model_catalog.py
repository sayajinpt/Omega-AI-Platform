"""Catalog + per-model runtime defaults for image generation."""

from __future__ import annotations

import pytest

pytest.importorskip("localgen")

from localgen.registry import (  # noqa: E402
    IMAGE_MODEL_CATALOG,
    STYLE_PRESETS,
    image_model_runtime_defaults,
    style_preset_by_key,
)


def test_catalog_includes_sd3_zimage_interdiffusion() -> None:
    repo_ids = {info.get("id") for info in IMAGE_MODEL_CATALOG.values()}
    assert "tensorart/stable-diffusion-3.5-medium-turbo" in repo_ids
    assert "Tongyi-MAI/Z-Image-Turbo" in repo_ids
    assert "cutycat2000/InterDiffusion-2.5" in repo_ids
    assert "cutycat2000/InterDiffusion-Nano" in repo_ids


def test_interdiffusion_nano_entry_has_correct_defaults() -> None:
    """InterDiffusion-Nano is SD 1.5 single-file — must use StableDiffusionPipeline + v1-5 config."""
    entry = next(
        info
        for info in IMAGE_MODEL_CATALOG.values()
        if info.get("id") == "cutycat2000/InterDiffusion-Nano"
    )
    assert entry["engine"] == "diffusers_single_file"
    assert entry["single_file_class"] == "StableDiffusionPipeline"
    assert entry["config_repo_id"] == "runwayml/stable-diffusion-v1-5"
    assert entry["default_width"] == 512
    assert entry["supports_negative_prompt"] is True


def test_interdiffusion_4_removed_from_catalog() -> None:
    repo_ids = {info.get("id") for info in IMAGE_MODEL_CATALOG.values()}
    assert "cutycat2000x/InterDiffusion-4.0" not in repo_ids


def test_style_presets_cover_requested_art_styles() -> None:
    keys = {str(v.get("key") or "").strip().lower() for v in STYLE_PRESETS.values()}
    for required in ("auto", "ghibli", "anime", "photorealistic", "cyberpunk", "pixar_3d"):
        assert required in keys, f"missing style preset key: {required}"


def test_style_preset_by_key_lookup_is_case_insensitive() -> None:
    g = style_preset_by_key("ghibli")
    assert g is not None
    assert "ghibli" in g["prompt_prefix"].lower()
    assert style_preset_by_key("GHIBLI") is g
    assert style_preset_by_key(" ghibli ") is g
    assert style_preset_by_key("does-not-exist") is None
    assert style_preset_by_key(None) is None
    assert style_preset_by_key("") is None


def test_zimage_entry_has_correct_defaults() -> None:
    entry = next(
        info for info in IMAGE_MODEL_CATALOG.values() if info.get("id") == "Tongyi-MAI/Z-Image-Turbo"
    )
    assert entry["engine"] == "zimage"
    assert entry["default_guidance_scale"] == 0.0
    assert entry["default_num_steps"] == 9
    assert entry["default_dtype"] == "bfloat16"
    assert entry["supports_negative_prompt"] is False
    assert entry["low_cpu_mem_usage"] is False


def test_interdiffusion_nano_entry_has_correct_defaults() -> None:
    """InterDiffusion-Nano on HF ships `model.safetensors`, not a repo-named checkpoint."""
    entry = next(
        info
        for info in IMAGE_MODEL_CATALOG.values()
        if info.get("id") == "cutycat2000/InterDiffusion-Nano"
    )
    assert entry["engine"] == "diffusers_single_file"
    assert entry["single_file_class"] == "StableDiffusionPipeline"
    assert entry["single_file_target"] == "model.safetensors"
    assert entry["config_repo_id"] == "runwayml/stable-diffusion-v1-5"


def test_interdiffusion_entry_has_correct_defaults() -> None:
    """InterDiffusion-2.5 on HF ships a single `model.safetensors` (no `model_index.json`),
    so it MUST be configured as a single-file SDXL checkpoint, not a generic diffusers pipeline."""
    entry = next(
        info
        for info in IMAGE_MODEL_CATALOG.values()
        if info.get("id") == "cutycat2000/InterDiffusion-2.5"
    )
    assert entry["engine"] == "diffusers_single_file"
    assert entry["single_file_class"] == "StableDiffusionXLPipeline"
    assert entry["single_file_target"] == "model.safetensors"
    # SDXL single-file checkpoints need scheduler/tokenizer/text-encoder configs from base.
    assert entry["config_repo_id"] == "stabilityai/stable-diffusion-xl-base-1.0"
    assert entry["supports_negative_prompt"] is True


def test_runtime_defaults_for_zimage() -> None:
    entry = next(
        info for info in IMAGE_MODEL_CATALOG.values() if info.get("id") == "Tongyi-MAI/Z-Image-Turbo"
    )
    d = image_model_runtime_defaults(entry)
    assert d["engine"] == "zimage"
    assert d["num_steps"] == 9
    assert d["guidance_scale"] == 0.0
    assert d["dtype"] == "bfloat16"
    assert d["supports_negative_prompt"] is False
    assert d["low_cpu_mem_usage"] is False


def test_runtime_defaults_for_sd3_checkpoint() -> None:
    entry = next(
        info
        for info in IMAGE_MODEL_CATALOG.values()
        if info.get("id") == "tensorart/stable-diffusion-3.5-medium-turbo"
    )
    d = image_model_runtime_defaults(entry)
    assert d["engine"] == "sd3"
    assert d["num_steps"] == 8
    assert d["guidance_scale"] == 7.0
    assert d["supports_negative_prompt"] is True


def test_runtime_defaults_fallback_for_unknown_entry() -> None:
    d = image_model_runtime_defaults({"id": "someone/random-model"})
    assert d["engine"] == "sd3"
    assert d["num_steps"] >= 4
    assert d["supports_negative_prompt"] is True
