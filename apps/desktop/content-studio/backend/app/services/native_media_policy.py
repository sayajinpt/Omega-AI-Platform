"""When Content Studio should use omega-runtime native media instead of in-process PyTorch."""

from __future__ import annotations

import os
from typing import Any


def should_use_native_media(
    payload: dict[str, Any],
    hf_tts_repo_id: str | None,
    hf_image_repo_id: str | None,
    no_image_mode: bool,
) -> bool:
    if payload.get("use_native_media") is False:
        return False
    # On-demand mode: omega-runtime spawns an isolated worker (`OMEGA_CS_WORKER=1`). The native
    # path HTTP-calls back into omega-runtime, which still launched media phases via fragile
    # cmd.exe env chains on Windows — TTS/images never load. Workers must run PyTorch in-process.
    if os.environ.get("OMEGA_CS_WORKER", "").strip() == "1":
        return payload.get("use_native_media") is True
    if payload.get("use_native_media") is True:
        return True
    env = (os.environ.get("OMEGA_NATIVE_MEDIA") or "0").strip().lower()
    if env in ("0", "false", "no"):
        return False
    if env in ("1", "true", "yes"):
        return True
    _ = no_image_mode
    _ = hf_tts_repo_id
    _ = hf_image_repo_id
    return False
