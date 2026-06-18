"""Tests for localgen paths and GPU slot helpers."""

from __future__ import annotations

import pytest


def test_get_models_root_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GENERATION_MODELS_DATA_DIR", raising=False)
    from localgen.paths import get_models_root

    p = get_models_root()
    assert p.name == "youtube_generation_models"


def test_get_models_root_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("GENERATION_MODELS_DATA_DIR", str(tmp_path))
    from localgen.paths import get_models_root

    assert get_models_root() == tmp_path.resolve()


def test_repo_folder_name() -> None:
    from localgen.paths import repo_folder_name

    assert repo_folder_name("org/My-Model") == "My-Model"


def test_gpu_runtime_slot_cycle() -> None:
    from localgen.gpu_runtime import active_gpu_kind, after_use, before_load, unload_all

    unload_all(reason="test_reset")
    assert active_gpu_kind() == "none"
    before_load("tts", reason="test")
    assert active_gpu_kind() == "tts"
    after_use(reason="test")
    assert active_gpu_kind() == "none"
    before_load("sd3", reason="test2")
    assert active_gpu_kind() == "sd3"
    unload_all(reason="test_end")
    assert active_gpu_kind() == "none"
