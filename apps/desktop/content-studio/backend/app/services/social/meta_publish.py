"""Instagram / Facebook publishing via Meta Graph API."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from app.config import settings
from app.services.runtime_credentials import patch_settings_object


def _graph_get(path: str, params: dict[str, str], token: str) -> dict:
    q = urllib.parse.urlencode({**params, "access_token": token})
    url = f"https://graph.facebook.com/v21.0/{path}?{q}"
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _graph_post(path: str, data: dict[str, str], token: str) -> dict:
    body = urllib.parse.urlencode({**data, "access_token": token}).encode("utf-8")
    url = f"https://graph.facebook.com/v21.0/{path}"
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def publish_instagram_reel(video_path: Path, caption: str) -> str:
    patch_settings_object(settings)
    token = (settings.meta_access_token or "").strip()
    ig_id = (settings.instagram_business_account_id or "").strip()
    if not token or not ig_id:
        raise RuntimeError("Set META_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID in Omega Settings.")

    # Resumable upload for Reels
    init = _graph_post(
        f"{ig_id}/media",
        {
            "media_type": "REELS",
            "caption": (caption or "")[:2200],
            "upload_type": "resumable",
        },
        token,
    )
    container_id = init.get("id")
    upload_url = init.get("upload_url") or init.get("uri")
    if not container_id or not upload_url:
        raise RuntimeError(f"Instagram init failed: {init}")

    data = video_path.read_bytes()
    up_req = urllib.request.Request(
        upload_url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"OAuth {token}",
            "offset": "0",
            "file_size": str(len(data)),
            "Content-Type": "application/octet-stream",
        },
    )
    with urllib.request.urlopen(up_req, timeout=600):
        pass

    for _ in range(60):
        status = _graph_get(container_id, {"fields": "status_code"}, token)
        code = status.get("status_code")
        if code == "FINISHED":
            break
        if code == "ERROR":
            raise RuntimeError(f"Instagram processing failed: {status}")
        time.sleep(3)
    else:
        raise RuntimeError("Instagram media processing timed out")

    pub = _graph_post(f"{ig_id}/media_publish", {"creation_id": container_id}, token)
    media_id = pub.get("id")
    if not media_id:
        raise RuntimeError(f"Instagram publish failed: {pub}")
    return f"https://www.instagram.com/reel/{media_id}/"


def publish_facebook_video(video_path: Path, title: str, description: str) -> str:
    patch_settings_object(settings)
    token = (settings.meta_access_token or "").strip()
    page_id = (settings.meta_page_id or "").strip()
    if not token or not page_id:
        raise RuntimeError("Set META_ACCESS_TOKEN and META_PAGE_ID in Omega Settings.")

    # Start upload session
    start = _graph_post(
        f"{page_id}/videos",
        {"upload_phase": "start", "file_size": str(video_path.stat().st_size)},
        token,
    )
    upload_session_id = start.get("upload_session_id") or start.get("video_id")
    if not upload_session_id:
        raise RuntimeError(f"Facebook upload start failed: {start}")

    data = video_path.read_bytes()
    chunk_size = 8 * 1024 * 1024
    offset = 0
    while offset < len(data):
        chunk = data[offset : offset + chunk_size]
        body = urllib.parse.urlencode(
            {
                "access_token": token,
                "upload_phase": "transfer",
                "upload_session_id": str(upload_session_id),
                "start_offset": str(offset),
            }
        ).encode("utf-8")
        url = f"https://graph-video.facebook.com/v21.0/{page_id}/videos"
        req = urllib.request.Request(url, data=body + chunk, method="POST")
        with urllib.request.urlopen(req, timeout=600):
            pass
        offset += len(chunk)

    finish = _graph_post(
        f"{page_id}/videos",
        {
            "upload_phase": "finish",
            "upload_session_id": str(upload_session_id),
            "title": title[:100],
            "description": (description or "")[:5000],
        },
        token,
    )
    vid = finish.get("id")
    if not vid:
        raise RuntimeError(f"Facebook finish failed: {finish}")
    return f"https://www.facebook.com/{page_id}/videos/{vid}"
