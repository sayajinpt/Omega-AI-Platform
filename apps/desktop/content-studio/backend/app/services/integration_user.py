"""Service account used by external agents (Hermes, etc.) calling the integration API."""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import User

INTEGRATION_USER_EMAIL = "integration-agent@media-automation.internal"
LEGACY_INTEGRATION_USER_EMAIL = "integration-agent@youtube-automation.internal"


def get_or_create_integration_user(db: Session, *, email: str | None = None) -> User:
    """Row that owns projects/jobs created via ``INTEGRATION_API_KEY`` (not password login)."""
    addr = (email or INTEGRATION_USER_EMAIL).strip().lower()
    if not email:
        for legacy in (LEGACY_INTEGRATION_USER_EMAIL,):
            u = db.execute(select(User).where(User.email == legacy)).scalar_one_or_none()
            if u:
                return u
    u = db.execute(select(User).where(User.email == addr)).scalar_one_or_none()
    if u:
        return u
    u = User(
        email=addr,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        name="Integration agent",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u
