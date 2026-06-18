"""CUDA sanity checks — compare Omega worker vs standalone qwen_tts_gui."""

from __future__ import annotations

import sys


def cuda_sanity_report(*, light: bool = False) -> str:
    """
    Return a one-line diagnostic (stderr + job logs).

    fp16 4096² matmul should be well under 50ms/step on a modern NVIDIA GPU.
    Hundreds of ms or CPU-only torch → expect very slow diffusion.
    """
    try:
        import torch
    except ImportError as exc:
        return f"torch_import_failed={exc!r}"

    bits: list[str] = [f"torch={getattr(torch, '__version__', '?')}"]
    if not torch.cuda.is_available():
        bits.append("cuda=unavailable (diffusion will use CPU — minutes per step)")
        return "; ".join(bits)

    if not light:
        try:
            from localgen.attention_backend import configure_pytorch_sdp_backends, ensure_cuda_dll_paths

            ensure_cuda_dll_paths()
            configure_pytorch_sdp_backends()
        except Exception:  # noqa: BLE001
            pass

    try:
        name = torch.cuda.get_device_name(0)
        cap = torch.cuda.get_device_capability(0)
        bits.append(f"gpu={name}")
        bits.append(f"cc={cap[0]}.{cap[1]}")
        free_b, total_b = torch.cuda.mem_get_info(0)
        bits.append(f"vram_free_mib={free_b // (1024 * 1024)}/{total_b // (1024 * 1024)}")
    except Exception as exc:  # noqa: BLE001
        bits.append(f"gpu_probe_err={exc!r}")

    if not light:
        try:
            import time

            torch.cuda.set_device(0)
            x = torch.randn(2048, 2048, device="cuda", dtype=torch.float16)
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            for _ in range(8):
                x = x @ x
            torch.cuda.synchronize()
            ms = (time.perf_counter() - t0) / 8 * 1000
            bits.append(f"fp16_matmul_2048={ms:.1f}ms")
            if ms > 80:
                bits.append("SLOW_GPU_KERNEL")
        except Exception as exc:  # noqa: BLE001
            bits.append(f"matmul_bench_failed={exc!r}")

    line = "; ".join(bits)
    print(f"localgen.cuda_sanity: {line}", file=sys.stderr, flush=True)
    return line
