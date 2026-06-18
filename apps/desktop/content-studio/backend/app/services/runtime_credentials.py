"""
Runtime credential overlay for Omega-injected API keys (Settings UI → POST /api/agent/v1/credentials).
Patches app.config.settings fields without writing .env on disk.
"""

from __future__ import annotations

import os
import threading
from typing import Any

_lock = threading.Lock()
_overlay: dict[str, str] = {}

# Fields accepted from Omega Settings (env-style names → Settings attribute names).
_FIELD_MAP: dict[str, str] = {
    "YOUTUBE_CLIENT_ID": "youtube_client_id",
    "YOUTUBE_CLIENT_SECRET": "youtube_client_secret",
    "YOUTUBE_REFRESH_TOKEN": "youtube_refresh_token",
    "YOUTUBE_UPLOAD_PRIVACY": "youtube_upload_privacy",
    "META_APP_ID": "meta_app_id",
    "META_APP_SECRET": "meta_app_secret",
    "META_ACCESS_TOKEN": "meta_access_token",
    "META_PAGE_ID": "meta_page_id",
    "INSTAGRAM_BUSINESS_ACCOUNT_ID": "instagram_business_account_id",
    "TIKTOK_CLIENT_KEY": "tiktok_client_key",
    "TIKTOK_CLIENT_SECRET": "tiktok_client_secret",
    "TIKTOK_ACCESS_TOKEN": "tiktok_access_token",
    "X_API_KEY": "x_api_key",
    "X_API_SECRET": "x_api_secret",
    "X_ACCESS_TOKEN": "x_access_token",
    "X_ACCESS_TOKEN_SECRET": "x_access_token_secret",
    "LINKEDIN_CLIENT_ID": "linkedin_client_id",
    "LINKEDIN_CLIENT_SECRET": "linkedin_client_secret",
    "LINKEDIN_ACCESS_TOKEN": "linkedin_access_token",
    "DEFAULT_HF_TTS_REPO_ID": "default_hf_tts_repo_id",
    "DEFAULT_HF_IMAGE_REPO_ID": "default_hf_image_repo_id",
    "CONTENT_SCRIPT_MODE": "content_script_mode",
    "CONTENT_OMEGA_MODEL_ID": "content_omega_model_id",
    "IMAGE_STEPS_BY_REPO_JSON": "image_steps_by_repo_json",
    "IMAGE_SIZE_BY_REPO_JSON": "image_size_by_repo_json",
    "IMAGE_NUM_STEPS": "image_num_steps",
    "VIDEO_STEPS_BY_REPO_JSON": "video_steps_by_repo_json",
    "VIDEO_SIZE_BY_REPO_JSON": "video_size_by_repo_json",
    "VIDEO_NUM_STEPS": "video_num_steps",
    "DEFAULT_HF_VIDEO_REPO_ID": "default_hf_video_repo_id",
    "IMAGE_LORA_ADAPTERS_JSON": "image_lora_adapters_json",
    "GENERATION_MODELS_DATA_DIR": "generation_models_data_dir",
    "OMEGA_CS_IMAGE_VRAM_MODE": "image_vram_mode",
}

_ATTR_TO_ENV: dict[str, str] = {attr: env_key for env_key, attr in _FIELD_MAP.items()}


def apply_credentials(payload: dict[str, Any]) -> dict[str, str]:
    """Merge non-empty credential fields into the overlay. Returns applied keys (names only)."""
    applied: list[str] = []
    with _lock:
        for key, raw in payload.items():
            if raw is None:
                continue
            env_key = key.upper().replace("-", "_")
            attr = _FIELD_MAP.get(env_key)
            if not attr:
                continue
            val = str(raw).strip()
            if not val:
                continue
            _overlay[attr] = val
            applied.append(attr)
    return {k: "***" for k in applied}


def patch_settings_object(settings_obj: Any) -> None:
    """Copy overlay values onto the live Settings instance."""
    with _lock:
        for attr, val in _overlay.items():
            if hasattr(settings_obj, attr):
                setattr(settings_obj, attr, val)


def credentials_status(settings_obj: Any) -> dict[str, bool]:
    """Which platforms have minimum credentials configured (after overlay)."""
    patch_settings_object(settings_obj)
    s = settings_obj
    return {
        "youtube": bool(
            (getattr(s, "youtube_client_id", "") or "").strip()
            and (getattr(s, "youtube_client_secret", "") or "").strip()
            and (getattr(s, "youtube_refresh_token", "") or "").strip()
        ),
        "instagram": bool(
            (getattr(s, "meta_access_token", "") or "").strip()
            and (getattr(s, "instagram_business_account_id", "") or "").strip()
        ),
        "facebook": bool(
            (getattr(s, "meta_access_token", "") or "").strip()
            and (getattr(s, "meta_page_id", "") or "").strip()
        ),
        "tiktok": bool((getattr(s, "tiktok_access_token", "") or "").strip()),
        "x": bool(
            (getattr(s, "x_api_key", "") or "").strip()
            and (getattr(s, "x_api_secret", "") or "").strip()
            and (getattr(s, "x_access_token", "") or "").strip()
            and (getattr(s, "x_access_token_secret", "") or "").strip()
        ),
        "linkedin": bool((getattr(s, "linkedin_access_token", "") or "").strip()),
        "threads": bool(
            (getattr(s, "meta_access_token", "") or "").strip()
            and (getattr(s, "instagram_business_account_id", "") or "").strip()
        ),
    }


def get_overlay_copy() -> dict[str, str]:
    with _lock:
        return dict(_overlay)


def overlay_to_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Merge the in-memory overlay into an env dict (for pipeline subprocess workers)."""
    env = dict(base or os.environ)
    with _lock:
        for attr, val in _overlay.items():
            if not val:
                continue
            env_key = _ATTR_TO_ENV.get(attr)
            if env_key:
                env[env_key] = val
    return env


def bootstrap_settings_from_env() -> None:
    """
    Apply credential env vars in this process, then patch ``settings``.

    The API server stores overlays in memory; subprocess workers only see env.
    """
    payload: dict[str, str] = {}
    for env_key in _FIELD_MAP:
        val = os.environ.get(env_key, "").strip()
        if val:
            payload[env_key] = val
    if payload:
        apply_credentials(payload)
    from app.config import settings

    storage = (os.environ.get("OMEGA_CS_STORAGE_PATH") or "").strip()
    if storage:
        settings.storage_path = storage
    patch_settings_object(settings)
