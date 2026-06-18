from __future__ import annotations

from app.models.enums import SocialPlatform
from app.services.social.base import SocialPublisher
from app.services.social.stubs import (
    FacebookPublisher,
    InstagramPublisher,
    LinkedInPublisher,
    ThreadsPublisher,
    TikTokPublisher,
    XPublisher,
)
from app.services.social.youtube import YouTubePublisher

_PUBLISHERS: dict[str, SocialPublisher] = {
    SocialPlatform.youtube.value: YouTubePublisher(),
    SocialPlatform.tiktok.value: TikTokPublisher(),
    SocialPlatform.instagram.value: InstagramPublisher(),
    SocialPlatform.x.value: XPublisher(),
    SocialPlatform.facebook.value: FacebookPublisher(),
    SocialPlatform.linkedin.value: LinkedInPublisher(),
    SocialPlatform.threads.value: ThreadsPublisher(),
}


def list_platforms() -> list[dict[str, str]]:
    return [
        {"id": pid, "name": pid.replace("_", " ").title(), "connect_hint": pub.connect_hint()}
        for pid, pub in _PUBLISHERS.items()
    ]


def get_publisher(platform: str) -> SocialPublisher | None:
    return _PUBLISHERS.get((platform or "").strip().lower())
