"""Tests for Hugging Face–style model folder discovery."""

from __future__ import annotations

from pathlib import Path

from app.services.model_folder_discovery import (
    discover_image_model_dir,
    discover_tts_model_dir,
    resolve_video_pack_dir,
)


def test_resolve_video_pack_dir_finds_ready_video_pack(tmp_path: Path) -> None:
    """Regression: must not NameError on snapshot_ready when video weights exist."""
    gen_root = tmp_path / "generation-models"
    pack = gen_root / "video" / "Lightricks__LTX-Video-0.9.5"
    (pack / "vae").mkdir(parents=True)
    (pack / "model_index.json").write_text("{}", encoding="utf-8")
    (pack / "vae" / "diffusion_pytorch_model.safetensors").write_bytes(b"\x00" * (101 * 1024 * 1024))

    resolved, label = resolve_video_pack_dir("Lightricks/LTX-Video-0.9.5", gen_root)
    assert resolved is not None
    assert resolved == pack
    assert "generation-models" in label
    root = tmp_path / "models"
    snap = root / "tts" / "anything_goes" / "snapshots" / "abc123"
    snap.mkdir(parents=True)
    (snap / "config.json").write_text("{}", encoding="utf-8")
    (snap / "model.safetensors").write_bytes(b"x")

    found = discover_tts_model_dir(root)
    assert found == snap


def test_discover_image_flat_folder(tmp_path: Path) -> None:
    root = tmp_path / "models"
    flat = root / "image" / "my_sd3_folder"
    flat.mkdir(parents=True)
    (flat / "model_index.json").write_text("{}", encoding="utf-8")

    found = discover_image_model_dir(root)
    assert found == flat
