"""Runtime inference for image packs outside IMAGE_MODEL_CATALOG."""

from __future__ import annotations

from pathlib import Path

from app.services.model_folder_discovery import (
    infer_image_model_info_from_dir,
    resolve_image_pack_dir,
)


def test_resolve_finds_model_studio_leaf_folder(tmp_path: Path) -> None:
    gen_root = tmp_path / "generation-models"
    models_dir = gen_root.parent
    pack = models_dir / "InterDiffusion-Nano"
    pack.mkdir(parents=True)
    ckpt = pack / "InterDiffusion-Nano.safetensors"
    ckpt.write_bytes(b"x" * (60 * 1024 * 1024))

    resolved, label = resolve_image_pack_dir("cutycat2000/InterDiffusion-Nano", gen_root)
    assert resolved == pack
    assert "models dir" in label


def test_resolve_finds_pack_via_sidecar(tmp_path: Path) -> None:
    gen_root = tmp_path / "generation-models"
    models_dir = gen_root.parent
    pack = models_dir / "InterDiffusion-Nano"
    pack.mkdir(parents=True)
    (pack / ".omega-hf-repo.json").write_text(
        '{"repo_id": "cutycat2000/InterDiffusion-Nano"}', encoding="utf-8"
    )
    (pack / "model.safetensors").write_bytes(b"x" * (60 * 1024 * 1024))

    resolved, _ = resolve_image_pack_dir("cutycat2000/InterDiffusion-Nano", gen_root)
    assert resolved == pack


def test_infer_diffusers_auto_from_model_index(tmp_path: Path) -> None:
    pack = tmp_path / "cutycat2000x__InterDiffusion-4.0"
    pack.mkdir()
    (pack / "model_index.json").write_text("{}", encoding="utf-8")

    info = infer_image_model_info_from_dir(pack, "cutycat2000x/InterDiffusion-4.0")
    assert info["engine"] == "diffusers_auto"


def test_infer_single_file_sdxl_from_name(tmp_path: Path) -> None:
    pack = tmp_path / "weights"
    pack.mkdir()
    (pack / "InterDiffusion-2.5.safetensors").write_bytes(b"x" * (60 * 1024 * 1024))

    info = infer_image_model_info_from_dir(pack, "cutycat2000/InterDiffusion-2.5")
    assert info["engine"] == "diffusers_single_file"
    assert info["single_file_class"] == "StableDiffusionXLPipeline"
    assert info["config_repo_id"] == "stabilityai/stable-diffusion-xl-base-1.0"


def test_infer_single_file_sd15_for_nano(tmp_path: Path) -> None:
    pack = tmp_path / "InterDiffusion-Nano"
    pack.mkdir()
    (pack / "model.safetensors").write_bytes(b"x" * (60 * 1024 * 1024))

    info = infer_image_model_info_from_dir(pack, "cutycat2000/InterDiffusion-Nano")
    assert info["engine"] == "diffusers_single_file"
    assert info["single_file_class"] == "StableDiffusionPipeline"
    assert info["config_repo_id"] == "runwayml/stable-diffusion-v1-5"
