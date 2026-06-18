"""Default HF repo ids when projects leave model selection unset."""

from __future__ import annotations

import pytest

pytest.importorskip("localgen")

from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from localgen.registry import DEFAULT_IMAGE_REPO_ID, DEFAULT_TTS_REPO_ID


def test_effective_tts_repo_id_uses_default_when_empty() -> None:
    assert effective_tts_repo_id(None) == DEFAULT_TTS_REPO_ID
    assert effective_tts_repo_id("") == DEFAULT_TTS_REPO_ID
    assert effective_tts_repo_id("  ") == DEFAULT_TTS_REPO_ID


def test_effective_tts_repo_id_keeps_user_pin() -> None:
    assert effective_tts_repo_id("aiseosae/qwenTTS") == "aiseosae/qwenTTS"


def test_effective_image_repo_id_uses_default_when_empty() -> None:
    assert effective_image_repo_id(None) == DEFAULT_IMAGE_REPO_ID
    assert effective_image_repo_id("") == DEFAULT_IMAGE_REPO_ID


def test_effective_image_repo_id_keeps_user_pin() -> None:
    assert effective_image_repo_id("Tongyi-MAI/Z-Image-Turbo") == "Tongyi-MAI/Z-Image-Turbo"


def test_registry_default_ids_match_catalog() -> None:
    from localgen.registry import IMAGE_MODEL_CATALOG, TTS_MODEL_CATALOG

    tts_ids = {e.get("id") for e in TTS_MODEL_CATALOG.values()}
    img_ids = {e.get("id") for e in IMAGE_MODEL_CATALOG.values()}
    assert DEFAULT_TTS_REPO_ID in tts_ids
    assert DEFAULT_IMAGE_REPO_ID in img_ids
