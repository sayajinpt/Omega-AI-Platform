"""Resolve Hugging Face Hub token for downloads (env or CLI-stored fallback)."""

from __future__ import annotations

import os


def hf_token_argument() -> str | None:
    """
    Token for ``snapshot_download``.

    - Explicit env vars first (Omega Settings → HuggingFace token).
    - Else cached ``huggingface-cli login`` token if present.
    - Else ``None`` for anonymous public-repo downloads (never ``True``, which forces a token).
    """
    t = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
    if t:
        return t
    try:
        from huggingface_hub import get_token

        cached = get_token()
        if cached:
            return cached
    except Exception:
        pass
    return None
