"""Apply user-selected diffusers LoRA adapters on top of a loaded image pipeline."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _adapter_weights_dir(models_root: Path, adapter_repo_id: str) -> Path:
    safe = adapter_repo_id.replace("/", "__")
    return models_root / "image-adapters" / safe


def apply_image_lora_adapters(
    pipe: Any,
    *,
    base_repo_id: str,
    adapters: list[dict[str, Any]],
    models_root: Path | None = None,
) -> list[str]:
    """
    Load and fuse LoRA weights for entries matching ``base_repo_id``.

    Returns human-readable labels for job logs.
    """
    if not adapters:
        return []

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        return []

    from localgen.hf_auth import hf_token_argument

    root = models_root
    if root is None:
        try:
            from app.services.generation_models_paths import generation_models_root

            root = generation_models_root()
        except Exception:
            import os

            raw = os.environ.get("GENERATION_MODELS_DATA_DIR", "").strip()
            root = Path(raw).expanduser() if raw else Path.home() / "media_generation_models"

    _tok = hf_token_argument()
    applied: list[str] = []
    base = (base_repo_id or "").strip()

    for entry in adapters:
        if str(entry.get("base_repo_id") or "").strip() != base:
            continue
        adapter_repo = str(entry.get("adapter_repo_id") or "").strip()
        if not adapter_repo:
            continue
        scale = float(entry.get("scale") or 1.0)
        adapter_file = str(entry.get("adapter_file") or "").strip()
        weight_path: str | None = None

        local_dir = _adapter_weights_dir(root, adapter_repo)
        if adapter_file:
            candidate = local_dir / adapter_file
            if candidate.is_file():
                weight_path = str(candidate)
        if weight_path is None and local_dir.is_dir():
            for pattern in ("*.safetensors", "*.bin"):
                matches = sorted(local_dir.rglob(pattern))
                for match in matches:
                    if match.is_file() and match.stat().st_size > 1024 * 1024:
                        weight_path = str(match)
                        break
                if weight_path:
                    break

        if weight_path is None:
            try:
                if adapter_file:
                    weight_path = hf_hub_download(
                        adapter_repo,
                        adapter_file,
                        local_dir=str(local_dir),
                        token=_tok,
                    )
                else:
                    weight_path = hf_hub_download(
                        repo_id=adapter_repo,
                        filename="pytorch_lora_weights.safetensors",
                        local_dir=str(local_dir),
                        token=_tok,
                    )
            except Exception:
                try:
                    if not local_dir.is_dir():
                        from localgen.downloads import download_snapshot

                        download_snapshot(adapter_repo, local_dir)
                    if adapter_file and (local_dir / adapter_file).is_file():
                        weight_path = str(local_dir / adapter_file)
                    else:
                        for match in local_dir.rglob("*.safetensors"):
                            if match.is_file() and match.stat().st_size > 512 * 1024:
                                weight_path = str(match)
                                break
                except Exception:
                    continue

        if not weight_path or not os.path.isfile(weight_path):
            continue

        adapter_name = adapter_repo.replace("/", "_")
        try:
            if os.path.isdir(weight_path):
                pipe.load_lora_weights(weight_path, adapter_name=adapter_name)
            else:
                pipe.load_lora_weights(weight_path, adapter_name=adapter_name)
            if hasattr(pipe, "fuse_lora"):
                try:
                    pipe.fuse_lora(lora_scale=scale)
                except TypeError:
                    pipe.fuse_lora()
            applied.append(f"{adapter_repo} (scale {scale:.2f})")
        except Exception:
            continue

    return applied
