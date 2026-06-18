from __future__ import annotations

from pathlib import Path

from app.config import settings
from app.services.runtime_credentials import patch_settings_object
from app.services.social.base import PublishRequest, PublishResult
from app.services.youtube_upload import upload_mp4_if_configured


class YouTubePublisher:
    platform_id = "youtube"

    def connect_hint(self) -> str:
        return (
            "Omega Settings → Content Studio: set YouTube Client ID/Secret, then Connect YouTube "
            "or paste a refresh token."
        )

    def publish(self, req: PublishRequest) -> PublishResult:
        patch_settings_object(settings)
        if not req.media_path:
            return PublishResult(ok=False, error="missing_media", detail="Video file path required for YouTube.")
        path = Path(req.media_path)
        if not path.is_file():
            return PublishResult(ok=False, error="file_not_found", detail=str(path))

        try:
            url = upload_mp4_if_configured(
                path,
                title=req.title[:100],
                description=(req.caption or req.title or "")[:5000],
            )
        except Exception as exc:
            return PublishResult(ok=False, error="upload_failed", detail=str(exc))

        if not url:
            return PublishResult(
                ok=False,
                error="not_configured",
                detail="Set YouTube OAuth credentials in Omega Settings → Content Studio.",
            )
        return PublishResult(ok=True, published_url=url)
