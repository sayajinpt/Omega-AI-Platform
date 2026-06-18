"""Studio UI exposes exactly one suggested model per modality."""

from __future__ import annotations

import pytest

pytest.importorskip("localgen")

from localgen.registry import (
    DEFAULT_IMAGE_REPO_ID,
    DEFAULT_TTS_REPO_ID,
    studio_suggested_image_catalog,
    studio_suggested_tts_catalog,
)


def test_studio_suggested_tts_is_single_06b_custom_voice() -> None:
    cat = studio_suggested_tts_catalog()
    assert len(cat) == 1
    assert "Qwen3-TTS-12Hz-0.6B-CustomVoice" in cat
    assert cat["Qwen3-TTS-12Hz-0.6B-CustomVoice"]["id"] == DEFAULT_TTS_REPO_ID


def test_studio_suggested_image_is_interdiffusion_nano() -> None:
    cat = studio_suggested_image_catalog()
    assert len(cat) == 1
    assert "InterDiffusion-Nano" in cat
    assert cat["InterDiffusion-Nano"]["id"] == DEFAULT_IMAGE_REPO_ID
