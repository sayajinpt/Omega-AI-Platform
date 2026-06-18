"""Scan ~/.omega/models/generation-models for installed TTS/image weights (no FastAPI import)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
GEN_MODELS = BACKEND.parent / "generation_models"
if GEN_MODELS.is_dir():
    sys.path.insert(0, str(GEN_MODELS.resolve()))


def main() -> int:
    from localgen.installed_models import list_models_for_ui, repo_snapshot_dir, _dir_nonempty
    from localgen.paths import get_models_root
    from localgen.registry import (
        DEFAULT_IMAGE_REPO_ID,
        DEFAULT_TTS_REPO_ID,
        studio_suggested_image_catalog,
        studio_suggested_tts_catalog,
    )

    def _entries(cat: dict, kind: str) -> list[dict]:
        root = get_models_root()
        out: list[dict] = []
        for key, meta in cat.items():
            repo_id = str(meta.get("id") or key)
            on_disk = _dir_nonempty(repo_snapshot_dir(root, kind, repo_id))  # type: ignore[arg-type]
            out.append(
                {
                    "key": key,
                    "repo_id": repo_id,
                    "description": str(meta.get("description") or ""),
                    "size": str(meta.get("size") or ""),
                    "on_disk": on_disk,
                }
            )
        return out

    def _installed(kind: str) -> list[dict]:
        return [
            {"key": label, "repo_id": repo_id, "description": "", "on_disk": on_disk}
            for repo_id, label, on_disk in list_models_for_ui(kind)  # type: ignore[arg-type]
            if on_disk
        ]

    suggested_tts = _entries(studio_suggested_tts_catalog(), "tts")
    suggested_image = _entries(studio_suggested_image_catalog(), "image")
    payload = {
        "defaults": {"tts": DEFAULT_TTS_REPO_ID, "image": DEFAULT_IMAGE_REPO_ID},
        "suggested_tts_models": suggested_tts,
        "suggested_image_models": suggested_image,
        "tts_models": suggested_tts,
        "image_models": suggested_image,
        "installed_tts": _installed("tts"),
        "installed_image": _installed("image"),
        "models_root": str(get_models_root()),
        "script_modes": ["content_studio", "omega_agent", "agent_orchestrated"],
        "active": {
            "tts": DEFAULT_TTS_REPO_ID,
            "image": DEFAULT_IMAGE_REPO_ID,
            "script_mode": "content_studio",
            "omega_model_id": "",
        },
    }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
