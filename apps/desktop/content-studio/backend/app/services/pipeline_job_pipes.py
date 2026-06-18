"""Track in-process diffusers pipelines per job so cancel can drop VRAM immediately."""

from __future__ import annotations

import threading
from typing import Any

_lock = threading.RLock()
_by_job: dict[str, Any] = {}


def register_job_image_pipe(job_id: str, pipe: Any) -> None:
    jid = job_id.strip()
    if not jid or pipe is None:
        return
    with _lock:
        _by_job[jid] = pipe


def dispose_job_image_pipe(job_id: str) -> None:
    """Drop the pipeline for a job (user stop). In-flight ``pipe()`` may still run until CUDA errors."""
    jid = job_id.strip()
    if not jid:
        return
    with _lock:
        pipe = _by_job.pop(jid, None)
    if pipe is None:
        return
    try:
        from localgen.gpu_runtime import dispose_sd3_pipeline

        dispose_sd3_pipeline(pipe, reason=f"cancel:{jid}")
    except Exception:  # noqa: BLE001
        pass


def clear_job_image_pipe(job_id: str) -> None:
    jid = job_id.strip()
    with _lock:
        _by_job.pop(jid, None)
