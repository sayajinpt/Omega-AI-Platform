"""On-device user row (same account as the PyQt desktop app)."""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import User

LOCAL_PROFILE_EMAIL = "local@media-automation.internal"
LEGACY_LOCAL_PROFILE_EMAIL = "local@youtube-automation.internal"


def _find_local_user(db: Session) -> User | None:
    for email in (LOCAL_PROFILE_EMAIL, LEGACY_LOCAL_PROFILE_EMAIL):
        u = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
        if u:
            return u
    return None


def get_or_create_local_user_db(db: Session) -> User:
    existing = _find_local_user(db)
    if existing:
        return existing
    u = User(
        email=LOCAL_PROFILE_EMAIL,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        name="This device",
    )
    db.add(u)
    try:
        db.commit()
        db.refresh(u)
        return u
    except IntegrityError:
        # Parallel API requests on startup can all miss the SELECT and race on INSERT.
        db.rollback()
        existing = _find_local_user(db)
        if existing:
            return existing
        raise
