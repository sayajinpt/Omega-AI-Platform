from __future__ import annotations

from pathlib import Path

from app.config import settings
from app.services.runtime_credentials import patch_settings_object
from app.services.social.base import PublishRequest, PublishResult
from app.services.social.meta_publish import publish_facebook_video, publish_instagram_reel
from app.services.social.tiktok_publish import publish_tiktok_video
from app.services.social.x_publish import publish_x_video


class TikTokPublisher:
    platform_id = "tiktok"

    def connect_hint(self) -> str:
        return "Omega Settings → Content Studio: TikTok Client Key/Secret + Access Token (Content Posting API)."

    def publish(self, req: PublishRequest) -> PublishResult:
        if not req.media_path:
            return PublishResult(ok=False, error="missing_media", detail="Video required.")
        try:
            url = publish_tiktok_video(Path(req.media_path), req.title)
            return PublishResult(ok=True, published_url=url)
        except Exception as exc:
            return PublishResult(ok=False, error="publish_failed", detail=str(exc))


class InstagramPublisher:
    platform_id = "instagram"

    def connect_hint(self) -> str:
        return "Meta Graph: Page access token + Instagram Business Account ID in Omega Settings."

    def publish(self, req: PublishRequest) -> PublishResult:
        if not req.media_path:
            return PublishResult(ok=False, error="missing_media", detail="Video required.")
        try:
            url = publish_instagram_reel(Path(req.media_path), req.caption or req.title)
            return PublishResult(ok=True, published_url=url)
        except Exception as exc:
            return PublishResult(ok=False, error="publish_failed", detail=str(exc))


class XPublisher:
    platform_id = "x"

    def connect_hint(self) -> str:
        return "X API keys + OAuth 1.0a user tokens in Omega Settings → Content Studio."

    def publish(self, req: PublishRequest) -> PublishResult:
        if not req.media_path:
            return PublishResult(ok=False, error="missing_media", detail="Video required.")
        try:
            text = (req.caption or req.title or "")[:280]
            url = publish_x_video(Path(req.media_path), text)
            return PublishResult(ok=True, published_url=url)
        except Exception as exc:
            return PublishResult(ok=False, error="publish_failed", detail=str(exc))


class FacebookPublisher:
    platform_id = "facebook"

    def connect_hint(self) -> str:
        return "Meta Graph: Page access token + Facebook Page ID in Omega Settings."

    def publish(self, req: PublishRequest) -> PublishResult:
        if not req.media_path:
            return PublishResult(ok=False, error="missing_media", detail="Video required.")
        try:
            url = publish_facebook_video(
                Path(req.media_path), req.title, req.caption or ""
            )
            return PublishResult(ok=True, published_url=url)
        except Exception as exc:
            return PublishResult(ok=False, error="publish_failed", detail=str(exc))


class LinkedInPublisher:
    platform_id = "linkedin"

    def connect_hint(self) -> str:
        return "Set LINKEDIN_ACCESS_TOKEN in Omega Settings (Marketing API / UGC)."

    def publish(self, req: PublishRequest) -> PublishResult:
        patch_settings_object(settings)
        token = (settings.linkedin_access_token or "").strip()
        if not token:
            return PublishResult(ok=False, error="not_configured", detail=self.connect_hint())
        return PublishResult(
            ok=False,
            error="not_implemented",
            detail="LinkedIn video UGC requires organization URN registration — token stored for future use.",
        )


class ThreadsPublisher:
    platform_id = "threads"

    def connect_hint(self) -> str:
        return "Threads uses Meta token; configure Instagram Business account in Settings."

    def publish(self, req: PublishRequest) -> PublishResult:
        # Threads API is similar to Instagram; reuse IG reel path when same token
        return InstagramPublisher().publish(req)
