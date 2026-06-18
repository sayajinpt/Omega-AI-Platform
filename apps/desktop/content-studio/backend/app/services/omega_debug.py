"""Best-effort bridge from Content Studio Python workers to the in-app Debug panel."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


def _runtime_port() -> str:
    env = (os.environ.get("OMEGA_RUNTIME_PORT") or "").strip()
    if env:
        return env
    state_path = Path.home() / ".omega" / "runtime-state.json"
    if state_path.is_file():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            port = data.get("port")
            if port is not None:
                return str(int(port))
        except (OSError, ValueError, TypeError):
            pass
    return "9877"


def _runtime_base() -> str:
    return f"http://127.0.0.1:{_runtime_port()}"


def emit_debug(
    message: str,
    *,
    source: str = "content-studio",
    level: str = "info",
    data: dict[str, Any] | None = None,
) -> None:
    """POST one line to omega-runtime /v1/debug/log (no-op on failure)."""
    if not message:
        return
    payload = {
        "source": source,
        "message": message,
        "level": level,
        "data": data or {},
    }
    try:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        req = urllib.request.Request(
            f"{_runtime_base()}/v1/debug/log",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except (urllib.error.URLError, OSError, ValueError, TypeError):
        pass
