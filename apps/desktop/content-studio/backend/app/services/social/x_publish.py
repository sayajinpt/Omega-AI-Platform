"""X (Twitter) video post via API v1.1 chunked upload + v2 tweet."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from uuid import uuid4

from app.config import settings
from app.services.runtime_credentials import patch_settings_object


def _oauth1_header(method: str, url: str, extra_params: dict[str, str]) -> str:
    patch_settings_object(settings)
    key = (settings.x_api_key or "").strip()
    secret = (settings.x_api_secret or "").strip()
    token = (settings.x_access_token or "").strip()
    token_secret = (settings.x_access_token_secret or "").strip()
    if not all([key, secret, token, token_secret]):
        raise RuntimeError("Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET in Omega Settings.")

    oauth_params = {
        "oauth_consumer_key": key,
        "oauth_nonce": uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
        **extra_params,
    }
    base_params = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
        for k, v in sorted(oauth_params.items())
    )
    base_url = url.split("?")[0]
    sig_base = "&".join(
        [
            method.upper(),
            urllib.parse.quote(base_url, safe=""),
            urllib.parse.quote(base_params, safe=""),
        ]
    )
    signing_key = f"{urllib.parse.quote(secret, safe='')}&{urllib.parse.quote(token_secret, safe='')}"
    signature = base64.b64encode(
        hmac.new(signing_key.encode(), sig_base.encode(), hashlib.sha1).digest()
    ).decode()
    oauth_params["oauth_signature"] = signature
    header_params = "&".join(
        f'{urllib.parse.quote(k, safe="")}="{urllib.parse.quote(v, safe="")}"'
        for k, v in sorted(oauth_params.items())
    )
    return f"OAuth {header_params}"


def publish_x_video(video_path: Path, text: str) -> str:
    media_url = "https://upload.twitter.com/1.1/media/upload.json"
    size = video_path.stat().st_size

    init_params = {"command": "INIT", "total_bytes": str(size), "media_type": "video/mp4"}
    init_body = urllib.parse.urlencode(init_params).encode()
    init_req = urllib.request.Request(
        media_url,
        data=init_body,
        method="POST",
        headers={
            "Authorization": _oauth1_header("POST", media_url, init_params),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(init_req, timeout=60) as resp:
        init = json.loads(resp.read().decode("utf-8"))
    media_id = init.get("media_id_string") or str(init.get("media_id", ""))
    if not media_id:
        raise RuntimeError(f"X INIT failed: {init}")

    segment_index = 0
    with video_path.open("rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            append_params = {
                "command": "APPEND",
                "media_id": media_id,
                "segment_index": str(segment_index),
            }
            append_req = urllib.request.Request(
                media_url,
                data=chunk,
                method="POST",
                headers={
                    "Authorization": _oauth1_header("POST", media_url, append_params),
                    "Content-Type": "application/octet-stream",
                },
            )
            with urllib.request.urlopen(append_req, timeout=600):
                pass
            segment_index += 1

    fin_params = {"command": "FINALIZE", "media_id": media_id}
    fin_body = urllib.parse.urlencode(fin_params).encode()
    fin_req = urllib.request.Request(
        media_url,
        data=fin_body,
        method="POST",
        headers={
            "Authorization": _oauth1_header("POST", media_url, fin_params),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(fin_req, timeout=120) as resp:
        fin = json.loads(resp.read().decode("utf-8"))

    tweet_url = "https://api.twitter.com/2/tweets"
    payload = json.dumps({"text": (text or "")[:280], "media": {"media_ids": [media_id]}}).encode()
    tweet_req = urllib.request.Request(
        tweet_url,
        data=payload,
        method="POST",
        headers={
            "Authorization": _oauth1_header("POST", tweet_url, {}),
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(tweet_req, timeout=60) as resp:
        tw = json.loads(resp.read().decode("utf-8"))
    tid = (tw.get("data") or {}).get("id")
    return f"https://x.com/i/web/status/{tid}" if tid else str(fin)
