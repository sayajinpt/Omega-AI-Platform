from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class PublishRequest:
    title: str
    caption: str | None
    media_path: str | None
    account_external_id: str | None = None


@dataclass
class PublishResult:
    ok: bool
    published_url: str | None = None
    error: str | None = None
    detail: str | None = None


class SocialPublisher(Protocol):
    platform_id: str

    def connect_hint(self) -> str:
        """Human-readable OAuth / setup instructions."""

    def publish(self, req: PublishRequest) -> PublishResult:
        ...
