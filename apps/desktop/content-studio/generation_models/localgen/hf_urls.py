"""Parse Hugging Face model page URLs or bare ``org/repo`` ids."""

from __future__ import annotations

import re
from urllib.parse import urlparse


_REPO_SLUG = re.compile(r"^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$")


def parse_hf_repo_id(text: str) -> str | None:
    """
    Accept:
    - ``organization/model-name``
    - ``https://huggingface.co/org/model``
    - optional trailing paths like ``/tree/main``, ``/blob/...``
    """
    raw = (text or "").strip()
    if not raw:
        return None

    if "://" not in raw and "/" in raw and _REPO_SLUG.match(raw):
        return raw

    try:
        u = urlparse(raw)
    except Exception:  # noqa: BLE001
        return None

    host = (u.netloc or "").lower()
    if host and host not in ("huggingface.co", "www.huggingface.co"):
        return None

    parts = [p for p in u.path.strip("/").split("/") if p]
    if len(parts) >= 2:
        if parts[0] in ("datasets", "spaces"):
            return None
        return f"{parts[0]}/{parts[1]}"
    return None
