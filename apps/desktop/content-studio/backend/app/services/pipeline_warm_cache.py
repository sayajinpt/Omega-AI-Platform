"""
Keep the last-loaded diffusers image pipeline in VRAM across jobs (standalone GUI behavior).

The PyQt ``qwen_tts_gui`` holds ``self.image_pipe`` between clicks; Omega used to dispose after
every ``run_sd3_images_for_job``, forcing a full reload (~7s+) before the first diffusion step.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

_lock = threading.RLock()
_entry: dict[str, Any] | None = None


def _cache_key(model_dir: Path, repo_id: str) -> str:
    rid = (repo_id or "").strip()
    return f"{model_dir.resolve()}::{rid}"


def get_warm_image_pipeline(model_dir: Path, repo_id: str) -> tuple[Any, str, dict[str, Any]] | None:
    with _lock:
        if _entry is None:
            return None
        if _entry.get("key") != _cache_key(model_dir, repo_id):
            return None
        return _entry["pipe"], _entry["label"], _entry["model_info"]


def set_warm_image_pipeline(
    model_dir: Path,
    repo_id: str,
    pipe: Any,
    label: str,
    model_info: dict[str, Any],
) -> None:
    with _lock:
        global _entry
        _entry = {
            "key": _cache_key(model_dir, repo_id),
            "pipe": pipe,
            "label": label,
            "model_info": dict(model_info),
        }


def clear_warm_image_pipeline() -> None:
    """Drop cached pipeline and free GPU memory."""
    with _lock:
        global _entry
        if _entry is None:
            return
        pipe = _entry.get("pipe")
        _entry = None
    if pipe is not None:
        try:
            from localgen.gpu_runtime import dispose_sd3_pipeline

            dispose_sd3_pipeline(pipe, reason="warm_cache_clear")
        except Exception:  # noqa: BLE001
            pass
        try:
            from localgen.gpu_runtime import unload_all

            unload_all(reason="warm_cache_clear")
        except Exception:  # noqa: BLE001
            pass
