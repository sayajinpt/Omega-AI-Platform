from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models import Series, User
from app.models.enums import VideoType
from app.schemas import SeriesCreate, SeriesRead, SeriesUpdate
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id

router = APIRouter(prefix="/series", tags=["series"])


def _get_owned_series(db: Session, user_id: str, series_id: str) -> Series:
    row = db.get(Series, series_id)
    if not row or row.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return row


@router.post("", response_model=SeriesRead, status_code=status.HTTP_201_CREATED)
def create_series(
    body: SeriesCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Series:
    s = Series(
        user_id=current.id,
        title=body.title,
        theme=body.theme,
        default_max_duration_seconds=body.default_max_duration_seconds,
        default_video_type=body.default_video_type,
        default_include_subtitles=body.default_include_subtitles,
        default_no_image_mode=body.default_no_image_mode,
        default_tts_speaker=body.default_tts_speaker,
        default_tts_language=body.default_tts_language,
        default_narration_tone=body.default_narration_tone,
        default_tts_voice_style=body.default_tts_voice_style,
        default_voice_gender=body.default_voice_gender,
        default_hf_tts_repo_id=effective_tts_repo_id(body.default_hf_tts_repo_id),
        default_hf_image_repo_id=effective_image_repo_id(body.default_hf_image_repo_id),
        default_image_style=(body.default_image_style or "").strip().lower() or None,
        is_active=body.is_active,
        topic_dedup_recent_count=body.topic_dedup_recent_count,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


@router.get("", response_model=list[SeriesRead])
def list_series(db: Session = Depends(get_db), current: User = Depends(get_current_user)) -> list[Series]:
    rows = db.execute(select(Series).where(Series.user_id == current.id).order_by(Series.updated_at.desc())).scalars().all()
    return list(rows)


@router.get("/{series_id}", response_model=SeriesRead)
def get_series(
    series_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Series:
    return _get_owned_series(db, current.id, series_id)


@router.put("/{series_id}", response_model=SeriesRead)
def update_series(
    series_id: str,
    body: SeriesUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Series:
    s = _get_owned_series(db, current.id, series_id)
    if body.title is not None:
        s.title = body.title
    if body.theme is not None:
        s.theme = body.theme
    if body.default_max_duration_seconds is not None:
        s.default_max_duration_seconds = body.default_max_duration_seconds
    if body.default_video_type is not None:
        s.default_video_type = body.default_video_type
    if body.default_include_subtitles is not None:
        s.default_include_subtitles = body.default_include_subtitles
    if body.default_no_image_mode is not None:
        s.default_no_image_mode = body.default_no_image_mode
    if body.topic_dedup_recent_count is not None:
        s.topic_dedup_recent_count = body.topic_dedup_recent_count
    if body.is_active is not None:
        s.is_active = body.is_active
    if body.default_tts_speaker is not None:
        s.default_tts_speaker = body.default_tts_speaker
    if body.default_tts_language is not None:
        s.default_tts_language = body.default_tts_language
    if body.default_narration_tone is not None:
        s.default_narration_tone = body.default_narration_tone
    if body.default_tts_voice_style is not None:
        s.default_tts_voice_style = body.default_tts_voice_style
    if body.default_voice_gender is not None:
        s.default_voice_gender = body.default_voice_gender
    if body.default_hf_tts_repo_id is not None:
        s.default_hf_tts_repo_id = effective_tts_repo_id(body.default_hf_tts_repo_id)
    if body.default_hf_image_repo_id is not None:
        s.default_hf_image_repo_id = effective_image_repo_id(body.default_hf_image_repo_id)
    if body.default_image_style is not None:
        s.default_image_style = (body.default_image_style or "").strip().lower() or None
    db.commit()
    db.refresh(s)
    return s
