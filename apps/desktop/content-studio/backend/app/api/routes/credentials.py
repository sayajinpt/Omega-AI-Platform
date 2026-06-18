"""Runtime credentials + OAuth (Omega Settings → Content Studio)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import get_integration_or_current_user
from app.config import settings
from app.database import get_db
from app.models import User
from app.services.runtime_credentials import apply_credentials, credentials_status, patch_settings_object
from app.services.youtube_oauth import exchange_code_for_refresh_token, youtube_auth_url
from sqlalchemy.orm import Session

router = APIRouter(prefix="/agent/v1", tags=["agent-credentials"])


class CredentialsPayload(BaseModel):
    """Keys from Omega Settings (env-style names)."""

    YOUTUBE_CLIENT_ID: str | None = None
    YOUTUBE_CLIENT_SECRET: str | None = None
    YOUTUBE_REFRESH_TOKEN: str | None = None
    YOUTUBE_UPLOAD_PRIVACY: str | None = None
    META_APP_ID: str | None = None
    META_APP_SECRET: str | None = None
    META_ACCESS_TOKEN: str | None = None
    META_PAGE_ID: str | None = None
    INSTAGRAM_BUSINESS_ACCOUNT_ID: str | None = None
    TIKTOK_CLIENT_KEY: str | None = None
    TIKTOK_CLIENT_SECRET: str | None = None
    TIKTOK_ACCESS_TOKEN: str | None = None
    X_API_KEY: str | None = None
    X_API_SECRET: str | None = None
    X_ACCESS_TOKEN: str | None = None
    X_ACCESS_TOKEN_SECRET: str | None = None
    LINKEDIN_CLIENT_ID: str | None = None
    LINKEDIN_CLIENT_SECRET: str | None = None
    LINKEDIN_ACCESS_TOKEN: str | None = None

    model_config = {"extra": "allow"}


class YoutubeOAuthExchange(BaseModel):
    code: str
    redirect_uri: str | None = None


@router.get("/credentials/status")
def get_credentials_status(
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, Any]:
    del current
    patch_settings_object(settings)
    return {"platforms": credentials_status(settings)}


@router.put("/credentials")
def put_credentials(
    body: CredentialsPayload,
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, Any]:
    del current
    applied = apply_credentials(body.model_dump(exclude_none=True))
    patch_settings_object(settings)
    return {"applied": list(applied.keys()), "platforms": credentials_status(settings)}


@router.get("/oauth/youtube/url")
def youtube_oauth_url(
    redirect_uri: str | None = None,
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, str]:
    del current
    try:
        url = youtube_auth_url(redirect_uri=redirect_uri)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"url": url, "redirect_uri": redirect_uri or settings.youtube_oauth_redirect_uri}


@router.post("/oauth/youtube/exchange")
def youtube_oauth_exchange(
    body: YoutubeOAuthExchange,
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, str]:
    del current
    try:
        refresh = exchange_code_for_refresh_token(body.code, redirect_uri=body.redirect_uri)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    apply_credentials({"YOUTUBE_REFRESH_TOKEN": refresh})
    patch_settings_object(settings)
    return {"refresh_token": refresh, "connected": True}
