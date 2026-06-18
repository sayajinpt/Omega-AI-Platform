"""TikTok Content Posting API (direct post)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

from app.config import settings
from app.services.runtime_credentials import patch_settings_object


def publish_tiktok_video(video_path: Path, title: str) -> str:
    patch_settings_object(settings)
    token = (settings.tiktok_access_token or "").strip()
    if not token:
        raise RuntimeError("Set TIKTOK_ACCESS_TOKEN in Omega Settings (OAuth after app approval).")

    init_body = json.dumps(
        {
            "post_info": {"title": title[:150], "privacy_level": "SELF_ONLY"},
            "source_info": {"source": "FILE_UPLOAD", "video_size": video_path.stat().st_size},
        }
    ).encode("utf-8")
    init_req = urllib.request.Request(
        "https://open.tiktokapis.com/v2/post/publish/video/init/",
        data=init_body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        },
    )
    with urllib.request.urlopen(init_req, timeout=60) as resp:
        init = json.loads(resp.read().decode("utf-8"))

    data = init.get("data") or {}
    upload_url = data.get("upload_url")
    publish_id = data.get("publish_id")
    if not upload_url or not publish_id:
        raise RuntimeError(f"TikTok init failed: {init}")

    video_bytes = video_path.read_bytes()
    up_req = urllib.request.Request(
        upload_url,
        data=video_bytes,
        method="PUT",
        headers={"Content-Type": "video/mp4", "Content-Length": str(len(video_bytes))},
    )
    with urllib.request.urlopen(up_req, timeout=600):
        pass

    status_body = json.dumps({"publish_id": publish_id}).encode("utf-8")
    status_req = urllib.request.Request(
        "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
        data=status_body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
        },
    )
    with urllib.request.urlopen(status_req, timeout=60) as resp:
        status = json.loads(resp.read().decode("utf-8"))

    return f"tiktok:publish_id:{publish_id}"
