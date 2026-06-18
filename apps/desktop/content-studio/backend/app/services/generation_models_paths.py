"""Resolve the generation-models root (always under ``~/.omega``)."""

from __future__ import annotations

from pathlib import Path


def generation_models_root() -> Path:
    """Folder containing ``tts/`` and ``image/`` Hugging Face snapshots."""
    from localgen.paths import get_models_root

    return get_models_root()
