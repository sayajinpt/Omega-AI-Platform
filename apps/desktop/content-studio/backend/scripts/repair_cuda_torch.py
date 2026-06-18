"""
Repair Content Studio venv when GPU extras downgraded PyTorch (cu128 on RTX 50xx).

Run from the Content Studio backend folder with the venv active:
  .venv\\Scripts\\python.exe scripts\\repair_cuda_torch.py
"""

from __future__ import annotations

import subprocess
import sys


def main() -> int:
    index = "https://download.pytorch.org/whl/cu130"
    print("repair_cuda_torch: reinstalling torch==2.11.0+cu130 from cu130 index…", flush=True)
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "torch==2.11.0+cu130",
            "torchvision==0.26.0+cu130",
            "torchaudio",
            "--index-url",
            index,
        ],
        check=False,
    )
    if r.returncode != 0:
        return r.returncode
    try:
        import torch

        print(
            f"repair_cuda_torch: torch {torch.__version__} cuda={torch.version.cuda} "
            f"available={torch.cuda.is_available()}",
            flush=True,
        )
        if torch.cuda.is_available():
            print(f"repair_cuda_torch: device={torch.cuda.get_device_name(0)}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"repair_cuda_torch: verify failed: {exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
