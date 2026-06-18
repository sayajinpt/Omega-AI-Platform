"""Implicit on-device user so the app works without signing in (DB still needs a user_id)."""

from __future__ import annotations

from app.database import SessionLocal
from app.models import User
from app.services.local_user import LOCAL_PROFILE_EMAIL, get_or_create_local_user_db


def get_or_create_local_user() -> User:
    db = SessionLocal()
    try:
        return get_or_create_local_user_db(db)
    finally:
        db.close()


def is_local_profile_user(user: User) -> bool:
    return user.email == LOCAL_PROFILE_EMAIL
