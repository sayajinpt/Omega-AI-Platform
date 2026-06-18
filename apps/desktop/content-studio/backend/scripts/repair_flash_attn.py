"""
Repair flash-attn when it is installed but fails to import (wrong cu128 wheel on cu130 torch).

Run from the Content Studio backend folder with the venv active:
  .venv\\Scripts\\python.exe scripts\\repair_flash_attn.py
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from install_gpu_extras import repair_flash_attn_mismatch  # noqa: E402


def main() -> int:
    ok = repair_flash_attn_mismatch()
    if ok:
        print("repair_flash_attn: FlashAttention loads successfully", flush=True)
        return 0
    print(
        "repair_flash_attn: still using PyTorch SDPA (slower steps). "
        "Delete stale wheels in ~/.omega/content-studio/prebuilt-wheels/flash_attn*.whl, "
        "ensure torch==2.11.0+cu130, then re-run Content Studio setup or this script.",
        flush=True,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
