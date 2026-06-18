import secrets

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import decode_token
from app.database import get_db
from app.services.local_user import get_or_create_local_user_db
from app.models import User
from app.services.integration_user import get_or_create_integration_user

security = HTTPBearer(auto_error=False)


def _configured_integration_key() -> str:
    return (settings.integration_api_key or "").strip()


def _integration_key_valid(provided: str | None) -> bool:
    expected = _configured_integration_key()
    if not expected or not provided:
        return False
    return secrets.compare_digest(provided.strip(), expected)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    user_id = decode_token(credentials.credentials)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def get_integration_or_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    integration_api_key: str | None = Header(default=None, alias="X-Integration-Api-Key"),
    db: Session = Depends(get_db),
) -> User:
    """
    Agent API user resolution.

    - **Local default** (``INTEGRATION_AUTH_REQUIRED=false``): same DB user as the desktop app
      (``local@youtube-automation.internal``) — no headers required.
    - **Optional lock-down**: set ``INTEGRATION_AUTH_REQUIRED=true`` and ``INTEGRATION_API_KEY``,
      then send ``X-Integration-Api-Key`` or ``Authorization: Bearer <key>``.
    - **JWT** still works for logged-in accounts when auth is required.
    """
    if not settings.integration_auth_required:
        return get_or_create_local_user_db(db)

    key_from_header = (integration_api_key or "").strip()
    if _integration_key_valid(key_from_header):
        return get_or_create_integration_user(db, email=settings.integration_user_email)

    if credentials is not None:
        token = (credentials.credentials or "").strip()
        if _integration_key_valid(token):
            return get_or_create_integration_user(db, email=settings.integration_user_email)
        user_id = decode_token(token)
        if user_id:
            user = db.get(User, user_id)
            if user:
                return user

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Integration auth is enabled. Provide X-Integration-Api-Key or JWT.",
    )
