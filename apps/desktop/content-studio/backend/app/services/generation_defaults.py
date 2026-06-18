"""Pinned HF repo ids used when a project has no explicit TTS / image model selection."""

from __future__ import annotations

from localgen.registry import DEFAULT_IMAGE_REPO_ID, DEFAULT_TTS_REPO_ID, DEFAULT_VIDEO_REPO_ID


def _settings_default(attr: str) -> str:
    try:
        from app.config import settings

        return (getattr(settings, attr, "") or "").strip()
    except Exception:
        return ""


def effective_tts_repo_id(preferred: str | None) -> str:
    """Return ``preferred`` when set, otherwise Omega/UI default, then app default TTS checkpoint."""
    rid = (preferred or "").strip()
    if not rid:
        rid = _settings_default("default_hf_tts_repo_id")
    return rid or DEFAULT_TTS_REPO_ID


def effective_image_repo_id(preferred: str | None) -> str:
    """Return ``preferred`` when set, otherwise Omega/UI default, then app default image checkpoint."""
    rid = (preferred or "").strip()
    if not rid:
        rid = _settings_default("default_hf_image_repo_id")
    return rid or DEFAULT_IMAGE_REPO_ID


def effective_video_repo_id(preferred: str | None) -> str:
    """Pinned HF repo id when set; otherwise empty (runtime auto-discovers under ``video/``)."""
    rid = (preferred or "").strip()
    if not rid:
        rid = _settings_default("default_hf_video_repo_id")
    if rid:
        return rid
    return DEFAULT_VIDEO_REPO_ID
