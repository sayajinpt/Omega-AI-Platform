from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.models import User

router = APIRouter(prefix="/youtube", tags=["youtube"])


@router.post("/auth")
def youtube_auth_start(current: User = Depends(get_current_user)) -> dict[str, str]:
    return {"detail": "OAuth start URL not configured (Phase 3)", "user_id": current.id}


@router.get("/callback")
def youtube_callback() -> dict[str, str]:
    return {"detail": "OAuth callback placeholder (Phase 3)"}


@router.post("/upload")
def youtube_upload(current: User = Depends(get_current_user)) -> dict[str, str]:
    return {"detail": "Upload not implemented (Phase 3)", "user_id": current.id}


@router.get("/analytics")
def youtube_analytics(current: User = Depends(get_current_user)) -> dict[str, str]:
    return {"detail": "Analytics not implemented (Phase 3)", "user_id": current.id}
