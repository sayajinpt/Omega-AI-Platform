"""Release Content Studio generation models (TTS + image) and CUDA cache."""

from __future__ import annotations


def release_generation_gpu(*, reason: str = "job_done") -> str:
    """
    Drop any warm diffusers pipeline and empty the CUDA cache in this worker process.

    Call after every pipeline job finishes (success, fail, or cancel) and before Omega
    reloads the chat LLM into VRAM.
    """
    if reason.startswith("cancel:"):
        job_id = reason.split(":", 1)[-1].strip()
        if job_id:
            try:
                from app.services.pipeline_job_pipes import dispose_job_image_pipe

                dispose_job_image_pipe(job_id)
            except Exception:  # noqa: BLE001
                pass
    try:
        from app.services.pipeline_warm_cache import clear_warm_image_pipeline

        clear_warm_image_pipeline()
    except Exception:  # noqa: BLE001
        pass
    try:
        from localgen.gpu_runtime import unload_all

        unload_all(reason=reason)
    except Exception as exc:  # noqa: BLE001
        return f"GPU release failed: {exc}"
    try:
        import torch

        if torch.cuda.is_available():
            free_b, total_b = torch.cuda.mem_get_info(0)
            free_mib = free_b // (1024 * 1024)
            total_mib = total_b // (1024 * 1024)
            return (
                f"Generation models released — {free_mib} MiB VRAM free / {total_mib} MiB total ({reason})"
            )
    except Exception:  # noqa: BLE001
        pass
    return f"Generation models released ({reason})"
