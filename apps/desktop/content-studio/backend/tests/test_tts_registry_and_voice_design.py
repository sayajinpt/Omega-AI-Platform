"""TTS catalog entries (including ``aiseosae/qwenTTS``) and ``generate_qwen_speech`` routing."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

import pytest

pytest.importorskip("localgen")

from localgen import engines
from localgen.registry import (
    TTS_MODEL_CATALOG,
    infer_tts_repo_id_from_model_dir,
    tts_generation_mode_for_repo,
)


def test_catalog_includes_aiseosae_qwen_tts() -> None:
    ids = {e.get("id") for e in TTS_MODEL_CATALOG.values()}
    assert "aiseosae/qwenTTS" in ids


def test_aiseosae_qwen_tts_is_voice_design() -> None:
    assert tts_generation_mode_for_repo("aiseosae/qwenTTS") == "voice_design"


def test_official_voice_design_checkpoint_tagged() -> None:
    assert tts_generation_mode_for_repo("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign") == "voice_design"


def test_custom_voice_checkpoints_default() -> None:
    assert tts_generation_mode_for_repo("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice") == "custom_voice"
    assert tts_generation_mode_for_repo(None) == "custom_voice"
    assert tts_generation_mode_for_repo("") == "custom_voice"


def test_infer_repo_id_from_nested_snapshot_path(tmp_path: Path) -> None:
    p = tmp_path / "tts" / "aiseosae__qwenTTS" / "snapshots" / "deadbeef"
    p.mkdir(parents=True)
    assert infer_tts_repo_id_from_model_dir(p) == "aiseosae/qwenTTS"


def test_infer_repo_id_from_official_style_path(tmp_path: Path) -> None:
    p = tmp_path / "tts" / "Qwen__Qwen3-TTS-12Hz-1.7B-CustomVoice"
    p.mkdir(parents=True)
    assert infer_tts_repo_id_from_model_dir(p) == "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"


def test_infer_repo_id_returns_none_outside_tts_tree(tmp_path: Path) -> None:
    p = tmp_path / "random" / "folder"
    p.mkdir(parents=True)
    assert infer_tts_repo_id_from_model_dir(p) is None


def test_generate_qwen_speech_voice_design_branch(tmp_path: Path) -> None:
    """``voice_design`` repos must call ``generate_voice_design`` with lowercased language."""

    class _M:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, Any]]] = []

        def generate_voice_design(self, **kwargs: Any) -> tuple[list[Any], int]:
            self.calls.append(("voice_design", kwargs))
            return ([np.zeros(64, dtype=np.float32)], 24000)

        def generate_custom_voice(self, **_kw: Any) -> None:
            raise AssertionError("custom_voice path must not run")

    m = _M()
    out = tmp_path / "out.wav"
    engines.generate_qwen_speech(
        m,
        "Hello world.",
        out,
        language="English",
        speaker="Ryan",
        instruct="A calm narrator.",
        hf_repo_id="aiseosae/qwenTTS",
    )
    assert len(m.calls) == 1
    assert m.calls[0][1]["text"] == "Hello world."
    ins = m.calls[0][1]["instruct"]
    assert "A calm narrator." in ins
    assert "Ryan" in ins
    assert "Male" in ins
    assert m.calls[0][1]["language"] == "english"
    assert out.is_file()


def test_generate_qwen_speech_voice_design_default_instruct(tmp_path: Path) -> None:
    class _M:
        def generate_voice_design(self, **kwargs: Any) -> tuple[list[Any], int]:
            self.kw = kwargs
            return ([np.zeros(32, dtype=np.float32)], 16000)

    m = _M()
    out = tmp_path / "x.wav"
    engines.generate_qwen_speech(
        m,
        "Hi",
        out,
        language="English",
        speaker="Ryan",
        instruct=None,
        hf_repo_id="aiseosae/qwenTTS",
    )
    assert "Clear, neutral narration" in m.kw["instruct"]
    assert "Ryan" in m.kw["instruct"]


def test_generate_qwen_speech_custom_voice_unchanged(tmp_path: Path) -> None:
    class _M:
        def generate_custom_voice(self, **kwargs: Any) -> tuple[list[Any], int]:
            self.kw = kwargs
            return ([np.zeros(48, dtype=np.float32)], 24000)

    m = _M()
    out = tmp_path / "c.wav"
    engines.generate_qwen_speech(
        m,
        "Line",
        out,
        language="English",
        speaker="Aiden",
        instruct=None,
        hf_repo_id="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    )
    assert m.kw["speaker"] == "Aiden"
    assert m.kw["language"] == "English"
    assert out.is_file()


def test_generate_qwen_speech_voice_design_prepends_gender_filter_when_set(tmp_path: Path) -> None:
    class _M:
        def __init__(self) -> None:
            self.kw: dict[str, Any] = {}

        def generate_voice_design(self, **kwargs: Any) -> tuple[list[Any], int]:
            self.kw = kwargs
            return ([np.zeros(32, dtype=np.float32)], 24000)

    m = _M()
    out = tmp_path / "g.wav"
    engines.generate_qwen_speech(
        m,
        "Hi",
        out,
        language="English",
        speaker="Sohee",
        instruct="Bright delivery.",
        hf_repo_id="aiseosae/qwenTTS",
        voice_gender="female",
    )
    ins = m.kw["instruct"]
    assert "female-presenting" in ins.lower()
    assert "Sohee" in ins
