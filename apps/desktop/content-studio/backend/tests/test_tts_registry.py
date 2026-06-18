"""TTS backend registry probes."""

from __future__ import annotations

from pathlib import Path

from localgen.tts_registry import probe_tts_backend


def test_probe_qwen_catalog_supported_when_package_present(monkeypatch) -> None:
    monkeypatch.setattr("localgen.tts_registry._qwen_optional_available", lambda: True)
    info = probe_tts_backend(None, "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    assert info.family == "qwen3_tts_custom_voice"
    assert info.backend_supported is True


def test_probe_piper_on_disk_without_package(tmp_path: Path, monkeypatch) -> None:
    pack = tmp_path / "en_US-lessac"
    pack.mkdir()
    (pack / "model.onnx").write_bytes(b"\x00" * 5000)
    monkeypatch.setattr("localgen.tts_registry._piper_optional_available", lambda: False)
    info = probe_tts_backend(pack, "rhasspy/piper-en")
    assert info.family == "piper"
    assert info.backend_supported is False
    assert info.unsupported_reason
    assert "piper-tts" in (info.unsupported_reason or "").lower()


def test_probe_xtts_repo_without_weights(monkeypatch) -> None:
    monkeypatch.setattr("localgen.tts_registry._xtts_optional_available", lambda: True)
    info = probe_tts_backend(None, "coqui/XTTS-v2")
    assert info.family == "xtts"
    assert info.backend_supported is False
