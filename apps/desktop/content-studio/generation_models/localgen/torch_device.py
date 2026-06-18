"""Pick a working PyTorch device for diffusers / Content Studio (separate from llama.cpp Vulkan)."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any, Literal

Accelerator = Literal["cuda", "directml", "cpu"]

_CUDA_PROBE_OK: bool | None = None
_DIRECTML_OK: bool | None = None


def cuda_works() -> bool:
    """True only when CUDA is available *and* can allocate on device 0."""
    global _CUDA_PROBE_OK
    if _CUDA_PROBE_OK is not None:
        return _CUDA_PROBE_OK
    try:
        import torch

        if not torch.cuda.is_available():
            _CUDA_PROBE_OK = False
            return False
        torch.zeros(1, device="cuda")
        torch.cuda.synchronize()
        _CUDA_PROBE_OK = True
        return True
    except Exception:  # noqa: BLE001
        _CUDA_PROBE_OK = False
        return False


def directml_works() -> bool:
    """Windows: AMD/Intel GPU via torch-directml (optional wheel)."""
    global _DIRECTML_OK
    if _DIRECTML_OK is not None:
        return _DIRECTML_OK
    if sys.platform != "win32":
        _DIRECTML_OK = False
        return False
    try:
        import torch_directml  # type: ignore[import-not-found]

        _ = torch_directml.device()
        _DIRECTML_OK = True
        return True
    except Exception:  # noqa: BLE001
        _DIRECTML_OK = False
        return False


def diffusers_accelerator(*, want_gpu: bool) -> Accelerator:
    if not want_gpu:
        return "cpu"
    if cuda_works():
        return "cuda"
    if directml_works():
        return "directml"
    return "cpu"


def resolve_torch_device(*, want_gpu: bool) -> Any:
    import torch

    acc = diffusers_accelerator(want_gpu=want_gpu)
    if acc == "cuda":
        return torch.device("cuda")
    if acc == "directml":
        import torch_directml  # type: ignore[import-not-found]

        return torch_directml.device()
    return torch.device("cpu")


def accelerator_label(acc: Accelerator) -> str:
    if acc == "cuda":
        return "CUDA"
    if acc == "directml":
        return "DirectML (AMD/Intel GPU)"
    return "CPU"


def effective_use_gpu(requested: bool) -> bool:
    """Whether we can use any GPU backend for diffusion (CUDA or DirectML)."""
    if not requested:
        return False
    return diffusers_accelerator(want_gpu=True) != "cpu"


def inference_dtype(*, want_gpu: bool) -> Any:
    """Default torch dtype for generative models on the active accelerator."""
    import torch

    acc = diffusers_accelerator(want_gpu=want_gpu)
    if acc == "cuda":
        return torch.bfloat16
    if acc == "directml":
        return torch.float16
    return torch.float32


def tts_load_device_map(*, want_gpu: bool) -> str | None:
    """``device_map`` for Hugging Face TTS loads (DirectML: CPU load then ``.to``)."""
    acc = diffusers_accelerator(want_gpu=want_gpu)
    if acc == "cuda":
        return "cuda:0"
    return "cpu"


def resolve_generator_device(pipe: Any, *, want_gpu: bool = True) -> Any:
    """Device for ``torch.Generator`` — follows pipeline or active accelerator."""
    import torch

    dev = getattr(pipe, "device", None)
    if dev is not None:
        return dev
    return resolve_torch_device(want_gpu=want_gpu and effective_use_gpu(want_gpu))


def move_module_to_device(obj: Any, *, want_gpu: bool) -> tuple[Any, Accelerator, str]:
    acc = diffusers_accelerator(want_gpu=want_gpu)
    label = accelerator_label(acc)
    if acc == "cpu":
        return obj, acc, label
    device = resolve_torch_device(want_gpu=True)
    if hasattr(obj, "to"):
        obj = obj.to(device)
    return obj, acc, label


@dataclass(frozen=True)
class ImageAccelSummary:
    accelerator: Accelerator
    cuda_torch_installed: bool
    message: str


def image_acceleration_summary() -> ImageAccelSummary:
    cuda_torch = False
    try:
        import torch

        ver = str(torch.__version__).lower()
        cuda_torch = "+cu" in ver or bool(torch.version.cuda)
    except Exception:  # noqa: BLE001
        pass

    acc = diffusers_accelerator(want_gpu=True)
    if acc == "cuda":
        msg = "Image generation will use NVIDIA CUDA."
    elif acc == "directml":
        msg = "Image generation will use DirectML on your AMD/Intel GPU."
    elif cuda_torch:
        msg = (
            "CUDA PyTorch is installed but no NVIDIA GPU is usable. "
            "Image generation will run on CPU (slow). Vulkan in Omega accelerates chat "
            "models only, not Content Studio diffusion."
        )
    else:
        msg = (
            "No GPU accelerator for image generation — using CPU (slow). "
            "NVIDIA GPUs use CUDA; AMD/Intel on Windows can use torch-directml after Python setup."
        )
    return ImageAccelSummary(accelerator=acc, cuda_torch_installed=cuda_torch, message=msg)


def log_image_acceleration() -> None:
    summary = image_acceleration_summary()
    print(f"localgen.device: {summary.message}", file=sys.stderr, flush=True)


def media_accelerators_report() -> dict[str, Any]:
    """JSON-friendly probe for omega-runtime system info / Settings UI."""
    summary = image_acceleration_summary()
    label = accelerator_label(summary.accelerator)
    row = {
        "accelerator": summary.accelerator,
        "label": label,
        "message": summary.message,
    }
    torch_ver = "unknown"
    directml_pkg = False
    try:
        import torch

        torch_ver = str(torch.__version__)
    except Exception:  # noqa: BLE001
        pass
    if sys.platform == "win32":
        try:
            import importlib.util

            directml_pkg = importlib.util.find_spec("torch_directml") is not None
        except Exception:  # noqa: BLE001
            directml_pkg = False
    return {
        "image": dict(row),
        "tts": dict(row),
        "video": dict(row),
        "torchVersion": torch_ver,
        "cudaWorks": cuda_works(),
        "directmlWorks": directml_works(),
        "directmlInstalled": directml_pkg,
        "cudaTorchInstalled": summary.cuda_torch_installed,
    }


def nvidia_gpu_detected() -> bool:
    """Best-effort host GPU vendor check (Windows WMI)."""
    if sys.platform == "win32":
        try:
            import subprocess

            r = subprocess.run(
                ["wmic", "path", "win32_VideoController", "get", "Name"],
                capture_output=True,
                text=True,
                timeout=12,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            text = ((r.stdout or "") + (r.stderr or "")).lower()
            if "nvidia" in text:
                return True
            if "amd" in text or "radeon" in text or "intel" in text:
                return False
        except Exception:  # noqa: BLE001
            pass
    override = os.environ.get("OMEGA_FORCE_CUDA_TORCH", "").strip().lower()
    if override in ("1", "true", "yes", "on"):
        return True
    return True  # unknown hardware: keep legacy CUDA install path
