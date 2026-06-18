"""`download_snapshot` rejects HF downloads that finish without a usable entry-point file."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("localgen")

from localgen import downloads as dl  # noqa: E402


def _stub_snapshot_download(*_a: Any, **_kw: Any) -> None:
    """No-op stand-in for huggingface_hub.snapshot_download (we control the dest contents in-tests)."""
    return None


def _pad_snapshot(dest: Path, mb: int = 81) -> None:
    (dest / "padding.bin").write_bytes(b"\x00" * (mb * 1024 * 1024))


def test_emit_download_progress_format(capsys) -> None:
    dl.emit_download_progress(1024, 2048, 512000)
    out = capsys.readouterr().out.strip()
    assert out.startswith(dl.PROGRESS_LINE_PREFIX)
    payload = json.loads(out[len(dl.PROGRESS_LINE_PREFIX) :])
    assert payload["bytes_done"] == 1024
    assert payload["bytes_total"] == 2048
    assert payload["speed_bps"] == 512000


def test_download_snapshot_accepts_top_level_model_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "model_index.json").write_text("{}", encoding="utf-8")
    (dest / "transformer" / "diffusion_pytorch_model.safetensors").parent.mkdir(parents=True)
    (dest / "transformer" / "diffusion_pytorch_model.safetensors").write_bytes(
        b"\x00" * (101 * 1024 * 1024)
    )
    out = dl.download_snapshot("org/repo", dest)
    assert out == dest


def test_download_snapshot_accepts_nested_model_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__repo"
    nested = dest / "inner-folder"
    nested.mkdir(parents=True)
    (nested / "model_index.json").write_text("{}", encoding="utf-8")
    (nested / "vae" / "diffusion_pytorch_model.safetensors").parent.mkdir(parents=True)
    (nested / "vae" / "diffusion_pytorch_model.safetensors").write_bytes(
        b"\x00" * (101 * 1024 * 1024)
    )
    out = dl.download_snapshot("org/repo", dest)
    assert out == dest


def test_download_snapshot_accepts_config_only_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Transformers-style (config.json + weights) is also valid for some TTS repos."""
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "tts" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "config.json").write_text("{}", encoding="utf-8")
    (dest / "model.safetensors").write_bytes(b"\x00" * (101 * 1024 * 1024))
    out = dl.download_snapshot("org/repo", dest)
    assert out == dest


def test_download_snapshot_accepts_single_file_safetensors_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """InterDiffusion-2.5-style repos ship ONLY `model.safetensors` (no model_index.json).
    The downloader must accept that layout as complete."""
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__single_file_model"
    dest.mkdir(parents=True)
    (dest / "model.safetensors").write_bytes(b"\x00" * (101 * 1024 * 1024))
    out = dl.download_snapshot("org/single_file_model", dest)
    assert out == dest


def test_download_snapshot_rejects_tiny_safetensors_pointer_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 1-KB safetensors file is almost certainly an LFS pointer, not real weights — reject."""
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__broken"
    dest.mkdir(parents=True)
    (dest / "model.safetensors").write_bytes(b"\x00" * 1024)
    with pytest.raises(RuntimeError, match="incomplete|no usable entry-point"):
        dl.download_snapshot("org/broken", dest)


def test_download_snapshot_rejects_empty_dest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__repo"
    dest.mkdir(parents=True)
    with pytest.raises(RuntimeError, match="incomplete|no usable entry-point"):
        dl.download_snapshot("org/repo", dest)


def test_download_snapshot_rejects_dest_with_only_readme(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "README.md").write_text("just docs", encoding="utf-8")
    (dest / ".gitattributes").write_text("...", encoding="utf-8")
    with pytest.raises(RuntimeError, match="incomplete|no usable entry-point"):
        dl.download_snapshot("org/repo", dest)


def test_download_snapshot_rejects_partial_config_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "tts" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="incomplete"):
        dl.download_snapshot("org/repo", dest)


def test_download_snapshot_rejects_model_index_without_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Diffusers layout with ``model_index.json`` but no safetensors must fail."""
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "video" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "model_index.json").write_text("{}", encoding="utf-8")
    (dest / "vae" / "config.json").parent.mkdir(parents=True)
    (dest / "vae" / "config.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="incomplete|no usable entry-point"):
        dl.download_snapshot("org/repo", dest)


def test_download_snapshot_rejects_incomplete_hf_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "video" / "org__repo"
    dest.mkdir(parents=True)
    (dest / "model_index.json").write_text("{}", encoding="utf-8")
    incomplete = dest / ".cache" / "huggingface" / "download" / "vae"
    incomplete.mkdir(parents=True)
    (incomplete / "blob.incomplete").write_bytes(b"\x00" * (101 * 1024 * 1024))
    with pytest.raises(RuntimeError, match="interrupted|incomplete"):
        dl.download_snapshot("org/repo", dest)


def test_prepare_snapshot_dest_wipes_poisoned_model_index_without_weights(
    tmp_path: Path,
) -> None:
    """Interrupted HF download: configs + .incomplete cache must not survive into resume."""
    dest = tmp_path / "video" / "Lightricks__LTX"
    dest.mkdir(parents=True)
    (dest / "model_index.json").write_text("{}", encoding="utf-8")
    (dest / "vae" / "config.json").parent.mkdir(parents=True)
    (dest / "vae" / "config.json").write_text("{}", encoding="utf-8")
    cache = dest / ".cache" / "huggingface" / "download" / "vae"
    cache.mkdir(parents=True)
    (cache / "weights.incomplete").write_bytes(b"\x00" * (512 * 1024 * 1024))
    dl._prepare_snapshot_dest(dest)
    assert not dest.exists() or not (dest / "model_index.json").exists()


def test_download_snapshot_error_message_includes_repo_and_remediation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dl, "snapshot_download", _stub_snapshot_download)
    dest = tmp_path / "image" / "org__repo"
    dest.mkdir(parents=True)
    with pytest.raises(RuntimeError) as excinfo:
        dl.download_snapshot("org/some-repo", dest)
    msg = str(excinfo.value).lower()
    assert "org/some-repo" in msg
    assert "retry" in msg
