"""Upload a rendered MP4 using YouTube Data API v3 (OAuth refresh token)."""

from __future__ import annotations

from pathlib import Path

from app.config import settings


def upload_mp4_if_configured(file_path: Path, title: str, description: str) -> str | None:
    """
    Resumable upload. Requires ``youtube_client_id``, ``youtube_client_secret``, and
    ``youtube_refresh_token`` in settings / env. Returns watch URL or ``None`` if upload is skipped.
    """
    cid = (settings.youtube_client_id or "").strip()
    secret = (settings.youtube_client_secret or "").strip()
    refresh = (settings.youtube_refresh_token or "").strip()
    if not (cid and secret and refresh):
        return None

    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError as exc:
        raise RuntimeError(
            "YouTube upload requires: pip install google-api-python-client google-auth google-auth-httplib2"
        ) from exc

    creds = Credentials(
        token=None,
        refresh_token=refresh,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=cid,
        client_secret=secret,
        scopes=["https://www.googleapis.com/auth/youtube.upload"],
    )
    creds.refresh(Request())

    youtube = build("youtube", "v3", credentials=creds)
    privacy = (settings.youtube_upload_privacy or "private").strip()
    if privacy not in ("public", "unlisted", "private"):
        privacy = "private"

    body = {
        "snippet": {"title": title[:100], "description": (description or "")[:5000]},
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }
    media = MediaFileUpload(str(file_path), chunksize=-1, resumable=True)
    req = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        _, response = req.next_chunk()
    vid = response.get("id") if isinstance(response, dict) else None
    return f"https://www.youtube.com/watch?v={vid}" if vid else None
