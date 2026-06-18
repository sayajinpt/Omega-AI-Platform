"""Resolve the root directory for Hugging Face snapshots (TTS / SD3 weights)."""

from __future__ import annotations

import os
from pathlib import Path


def _omega_home() -> Path:
    raw = (os.environ.get("OMEGA_HOME") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".omega").expanduser().resolve()


def _is_under_omega(path: Path) -> bool:
    try:
        path.resolve().relative_to(_omega_home())
        return True
    except ValueError:
        return False


def get_models_root() -> Path:
    """Writable HF snapshots live under ``~/.omega/models/generation-models`` only."""
    default = (_omega_home() / "models" / "generation-models").resolve()
    raw = (os.environ.get("GENERATION_MODELS_DATA_DIR") or "").strip()
    if raw:
        candidate = Path(raw).expanduser().resolve()
        if _is_under_omega(candidate):
            return candidate
    return default


def repo_folder_name(repo_id: str) -> str:
    """Last path segment of org/name — used as subdirectory under models root."""
    return repo_id.split("/")[-1]
