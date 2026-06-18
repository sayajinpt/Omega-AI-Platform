"""Single-GPU discipline: only one heavy model family should occupy VRAM at a time."""

from __future__ import annotations

import gc
import threading
from typing import Any, Callable, Literal

Kind = Literal["none", "tts", "sd3"]

_lock = threading.RLock()
_active: Kind = "none"
_event_log: Callable[[str], None] | None = None


def set_event_sink(sink: Callable[[str], None] | None) -> None:
    """Optional callback (e.g. desktop console) for load/unload messages."""
    global _event_log
    _event_log = sink


def _emit(msg: str) -> None:
    if _event_log:
        try:
            _event_log(msg)
        except Exception:  # noqa: BLE001
            pass


def active_gpu_kind() -> Kind:
    with _lock:
        return _active


def status_line() -> str:
    k = active_gpu_kind()
    if k == "none":
        return "GPU models: idle (no TTS/SD3 slot held)"
    if k == "tts":
        return "GPU models: TTS slot active — unload before loading SD3 if VRAM is tight"
    return "GPU models: SD3 slot active — unload before loading TTS if VRAM is tight"


def _cuda_gc(*, sync: bool = False) -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            if sync:
                torch.cuda.synchronize()
    except Exception:  # noqa: BLE001
        pass


def _vram_free_mib() -> str | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free_b, total_b = torch.cuda.mem_get_info(0)
        return f"{free_b // (1024 * 1024)}/{total_b // (1024 * 1024)} MiB free"
    except Exception:  # noqa: BLE001
        return None


def before_load(kind: Literal["tts", "sd3"], *, reason: str = "") -> None:
    """Call immediately before loading weights. Frees VRAM if switching family or re-entering."""
    global _active
    with _lock:
        prev = _active
        vram = _vram_free_mib()
        vram_suffix = f" ({vram})" if vram else ""
        if prev not in ("none", kind):
            _emit(
                f"[gpu] switching {prev} → {kind}; clearing CUDA cache ({reason or 'before_load'}){vram_suffix}"
            )
            _cuda_gc(sync=True)
        elif prev == "none":
            _emit(f"[gpu] preparing {kind} ({reason or 'before_load'}){vram_suffix}")
            _cuda_gc()
        _active = kind


def after_use(*, reason: str = "") -> None:
    """Call in ``finally`` after you ``del`` the model / pipeline (or when abandoning load)."""
    global _active
    with _lock:
        _active = "none"
        _emit(f"[gpu] released slot ({reason or 'after_use'})")
        _cuda_gc(sync=True)


def dispose_qwen_tts_model(model: Any | None, *, reason: str = "dispose_tts") -> None:
    """
    Drop a Qwen3 TTS model reference and free VRAM.

    Same rationale as :func:`dispose_sd3_pipeline` — no ``.to("cpu")`` move; just drop
    the reference and let ``after_use`` reclaim VRAM via ``torch.cuda.empty_cache()``.
    """
    if model is not None:
        try:
            del model
        except Exception:  # noqa: BLE001
            pass
    after_use(reason=reason)


def dispose_video_pipeline(pipe: Any | None, *, reason: str = "dispose_video") -> None:
    """Drop a T2V pipeline reference and free VRAM (same discipline as SD3)."""
    dispose_sd3_pipeline(pipe, reason=reason)


def dispose_sd3_pipeline(pipe: Any | None, *, reason: str = "dispose_sd3") -> None:
    """
    Drop a diffusers pipeline reference and free VRAM.

    We intentionally do NOT call ``pipe.to("cpu")`` first: diffusers warns against moving
    half-precision (fp16 / bf16) pipelines to CPU because they can't run there, and the
    move doesn't release VRAM any faster than just dropping the reference and letting
    ``torch.cuda.empty_cache()`` reclaim. The ``del`` + ``after_use`` combo handles it.
    """
    if pipe is not None:
        try:
            del pipe
        except Exception:  # noqa: BLE001
            pass
    after_use(reason=reason)


def unload_all(*, reason: str = "manual_unload") -> None:
    """Public \"free VRAM\" — clears process CUDA cache; caller must not keep live model refs."""
    global _active
    with _lock:
        _active = "none"
        _emit(f"[gpu] unload_all ({reason})")
        _cuda_gc(sync=True)
