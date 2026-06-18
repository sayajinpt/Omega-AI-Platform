"""Multi-platform social publishing API."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_integration_or_current_user
from app.database import get_db
from app.models import SocialAccount, SocialPost, User, VideoProject
from app.models.enums import SocialPlatform, SocialPostStatus
from app.services.social.publish import publish_post, resolve_media_for_project
from app.services.social.registry import list_platforms

router = APIRouter(prefix="/social", tags=["social"])


class SocialAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    platform: str
    account_label: str | None
    external_id: str | None
    is_active: bool


class SocialPostCreate(BaseModel):
    platform: str
    title: str = Field(max_length=512)
    caption: str | None = None
    project_id: str | None = None
    media_path: str | None = None
    account_id: str | None = None
    publish_now: bool = False
    scheduled_at: datetime | None = None


class SocialPostRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    platform: str
    title: str
    caption: str | None
    project_id: str | None
    status: str
    published_url: str | None
    error_message: str | None
    scheduled_at: datetime | None


def _row_to_account(row: SocialAccount) -> SocialAccountRead:
    plat = row.platform.value if hasattr(row.platform, "value") else str(row.platform)
    return SocialAccountRead(
        id=row.id,
        platform=plat,
        account_label=row.account_label,
        external_id=row.external_id,
        is_active=bool(row.is_active),
    )


def _row_to_post(row: SocialPost) -> SocialPostRead:
    plat = row.platform.value if hasattr(row.platform, "value") else str(row.platform)
    st = row.status.value if hasattr(row.status, "value") else str(row.status)
    return SocialPostRead(
        id=row.id,
        platform=plat,
        title=row.title,
        caption=row.caption,
        project_id=row.project_id,
        status=st,
        published_url=row.published_url,
        error_message=row.error_message,
        scheduled_at=row.scheduled_at,
    )


@router.get("/platforms")
def social_platforms() -> list[dict[str, str]]:
    return list_platforms()


@router.get("/accounts", response_model=list[SocialAccountRead])
def list_accounts(
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> list[SocialAccountRead]:
    try:
        rows = db.scalars(
            select(SocialAccount)
            .where(SocialAccount.user_id == current.id)
            .order_by(SocialAccount.created_at.desc())
        ).all()
        return [_row_to_account(r) for r in rows]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"social_accounts: {exc}",
        ) from exc


class SocialAccountCreate(BaseModel):
    platform: str
    account_label: str | None = None
    external_id: str | None = None


@router.post("/accounts", response_model=SocialAccountRead, status_code=status.HTTP_201_CREATED)
def connect_account(
    body: SocialAccountCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> SocialAccount:
    try:
        plat = SocialPlatform(body.platform.strip().lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported platform: {body.platform}") from exc
    row = SocialAccount(
        user_id=current.id,
        platform=plat,
        account_label=body.account_label,
        external_id=body.external_id,
        is_active=True,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_to_account(row)


@router.get("/posts", response_model=list[SocialPostRead])
def list_posts(
    limit: int = 50,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> list[SocialPostRead]:
    rows = db.scalars(
        select(SocialPost)
        .where(SocialPost.user_id == current.id)
        .order_by(SocialPost.updated_at.desc())
        .limit(min(limit, 200))
    ).all()
    return [_row_to_post(r) for r in rows]


@router.post("/posts", response_model=SocialPostRead, status_code=status.HTTP_201_CREATED)
def create_post(
    body: SocialPostCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> SocialPost:
    try:
        plat = SocialPlatform(body.platform.strip().lower())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unsupported platform: {body.platform}") from exc

    media = body.media_path
    if body.project_id and not media:
        media = resolve_media_for_project(db, body.project_id)
        proj = db.get(VideoProject, body.project_id)
        if not proj or proj.user_id != current.id:
            raise HTTPException(status_code=404, detail="Project not found")

    account: SocialAccount | None = None
    if body.account_id:
        account = db.get(SocialAccount, body.account_id)
        if not account or account.user_id != current.id:
            raise HTTPException(status_code=404, detail="Account not found")

    post = SocialPost(
        user_id=current.id,
        project_id=body.project_id,
        account_id=body.account_id,
        platform=plat,
        title=body.title[:512],
        caption=body.caption,
        media_path=media,
        status=SocialPostStatus.scheduled if body.scheduled_at else SocialPostStatus.draft,
        scheduled_at=body.scheduled_at,
    )
    db.add(post)
    db.commit()
    db.refresh(post)

    if body.publish_now:
        publish_post(db, post, account=account)
    return _row_to_post(post)


@router.post("/posts/{post_id}/publish", response_model=SocialPostRead)
def publish_now(
    post_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> SocialPost:
    post = db.get(SocialPost, post_id)
    if not post or post.user_id != current.id:
        raise HTTPException(status_code=404, detail="Post not found")
    account = db.get(SocialAccount, post.account_id) if post.account_id else None
    published = publish_post(db, post, account=account)
    return _row_to_post(published)
