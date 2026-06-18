"""Release diffusion VRAM before TTS (image and TTS must not share the GPU)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import JobLog


def release_image_vram_before_tts(db: Session, job_id: str) -> None:
    """
    Drop warm image pipeline, per-job pipe refs, and CUDA cache before loading TTS.

    ``before_load("tts")`` only empties the allocator cache; it does not delete the
    diffusers pipeline still held in ``pipeline_warm_cache``.
    """
    jid = job_id.strip()
    parts: list[str] = []

    try:
        from app.services.pipeline_job_pipes import dispose_job_image_pipe

        dispose_job_image_pipe(jid)
        parts.append("job_pipe")
    except Exception as exc:  # noqa: BLE001
        parts.append(f"job_pipe_err={exc}")

    try:
        from app.services.pipeline_warm_cache import clear_warm_image_pipeline

        clear_warm_image_pipeline()
        parts.append("warm_cache")
    except Exception as exc:  # noqa: BLE001
        parts.append(f"warm_err={exc}")

    try:
        from localgen.gpu_runtime import unload_all

        unload_all(reason=f"before_tts:{jid[:8]}")
        parts.append("cuda_cache")
    except Exception as exc:  # noqa: BLE001
        parts.append(f"unload_err={exc}")

    vram_line = _vram_log_line("before TTS")
    db.add(
        JobLog(
            job_id=jid,
            level="info",
            message=(
                "GPU: image models unloaded before TTS "
                f"({', '.join(parts)}). {vram_line}".strip()
            ),
        )
    )
    db.commit()

    try:
        import sys

        print(f"localgen.gpu: image VRAM released before TTS ({', '.join(parts)})", file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001
        pass


def _vram_log_line(label: str) -> str:
    try:
        import torch

        if not torch.cuda.is_available():
            return f"VRAM [{label}]: CUDA not available."
        free_b, total_b = torch.cuda.mem_get_info(0)
        free_mib = free_b // (1024 * 1024)
        total_mib = total_b // (1024 * 1024)
        return f"VRAM [{label}]: {free_mib} MiB free / {total_mib} MiB total."
    except Exception as exc:  # noqa: BLE001
        return f"VRAM [{label}]: probe failed ({exc})."
