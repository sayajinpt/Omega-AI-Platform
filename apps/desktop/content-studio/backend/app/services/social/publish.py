from __future__ import annotations

from sqlalchemy.orm import Session

from app.config import settings
from app.models import SocialAccount, SocialPost, VideoProject
from app.models.enums import SocialPostStatus
from app.services.runtime_credentials import patch_settings_object
from app.services.social.base import PublishRequest
from app.services.social.registry import get_publisher


def publish_post(db: Session, post: SocialPost, *, account: SocialAccount | None = None) -> SocialPost:
    patch_settings_object(settings)
    pub = get_publisher(post.platform.value if hasattr(post.platform, "value") else str(post.platform))
    if not pub:
        post.status = SocialPostStatus.failed
        post.error_message = f"Unknown platform: {post.platform}"
        db.commit()
        return post

    req = PublishRequest(
        title=post.title,
        caption=post.caption,
        media_path=post.media_path,
        account_external_id=(account.external_id if account else None),
    )
    post.status = SocialPostStatus.publishing
    db.commit()

    result = pub.publish(req)
    if result.ok:
        post.status = SocialPostStatus.published
        post.published_url = result.published_url
        post.error_message = None
    else:
        post.status = SocialPostStatus.failed
        post.error_message = result.detail or result.error or "publish failed"
    db.commit()
    db.refresh(post)
    return post


def resolve_media_for_project(db: Session, project_id: str | None) -> str | None:
    if not project_id:
        return None
    project = db.get(VideoProject, project_id)
    if not project or not project.videos:
        return None
    for video in reversed(project.videos):
        if video.file_path:
            return video.file_path
    return None
