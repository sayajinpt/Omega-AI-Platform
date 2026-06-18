"""Google OAuth2 helpers for YouTube upload scope."""

from __future__ import annotations

import json
import urllib.parse
import urllib.request

from app.config import settings
from app.services.runtime_credentials import patch_settings_object

YOUTUBE_SCOPES = "https://www.googleapis.com/auth/youtube.upload"


def youtube_auth_url(*, redirect_uri: str | None = None) -> str:
    patch_settings_object(settings)
    cid = (settings.youtube_client_id or "").strip()
    if not cid:
        raise ValueError("youtube_client_id is not set")
    redir = (redirect_uri or settings.youtube_oauth_redirect_uri or "").strip()
    params = {
        "client_id": cid,
        "redirect_uri": redir,
        "response_type": "code",
        "scope": YOUTUBE_SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


def exchange_code_for_refresh_token(code: str, *, redirect_uri: str | None = None) -> str:
    patch_settings_object(settings)
    cid = (settings.youtube_client_id or "").strip()
    secret = (settings.youtube_client_secret or "").strip()
    if not cid or not secret:
        raise ValueError("youtube_client_id and youtube_client_secret required")
    redir = (redirect_uri or settings.youtube_oauth_redirect_uri or "").strip()
    body = urllib.parse.urlencode(
        {
            "code": code.strip(),
            "client_id": cid,
            "client_secret": secret,
            "redirect_uri": redir,
            "grant_type": "authorization_code",
        }
    ).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    refresh = data.get("refresh_token")
    if not refresh:
        raise ValueError(
            "No refresh_token in response (re-authorize with prompt=consent if you already granted access)."
        )
    return str(refresh)
