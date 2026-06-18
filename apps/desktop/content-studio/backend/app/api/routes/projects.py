from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models import Job, Series, User, VideoProject
from app.models.enums import ProjectStatus, VideoType
from app.schemas import VideoProjectCreate, VideoProjectRead, VideoProjectUpdate, JobRead
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.pipeline_jobs import enqueue_pipeline_job

router = APIRouter(prefix="/projects", tags=["projects"])


def _get_owned_project(db: Session, user_id: str, project_id: str) -> VideoProject:
    project = db.get(VideoProject, project_id)
    if not project or project.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _resolve_video_type_for_create(body: VideoProjectCreate, series: Series | None) -> VideoType:
    if body.video_type is not None:
        return body.video_type
    if series and series.default_video_type is not None:
        return series.default_video_type
    return VideoType.youtube_long_16_9


@router.post("", response_model=VideoProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    body: VideoProjectCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> VideoProject:
    series: Series | None = None
    if body.series_id:
        series = db.get(Series, body.series_id)
        if not series or series.user_id != current.id:
            raise HTTPException(status_code=400, detail="Invalid series_id")

    resolved_type = _resolve_video_type_for_create(body, series)

    inc_sub = body.include_subtitles
    if inc_sub is None:
        inc_sub = bool(series.default_include_subtitles) if series else False
    ai_title = body.use_ai_video_title if body.use_ai_video_title is not None else True
    web_r = body.script_use_web_research if body.script_use_web_research is not None else True
    no_img = body.no_image_mode
    if no_img is None:
        no_img = bool(getattr(series, "default_no_image_mode", False)) if series else False

    act = body.is_active if body.is_active is not None else True
    project = VideoProject(
        user_id=current.id,
        series_id=body.series_id,
        title=body.title,
        theme=body.theme,
        max_duration_seconds=body.max_duration_seconds,
        video_type=resolved_type,
        content_notes=body.content_notes,
        episode_topic=body.episode_topic,
        topic_dedup_recent_count=body.topic_dedup_recent_count,
        include_subtitles=inc_sub,
        use_ai_video_title=ai_title,
        tts_speaker=body.tts_speaker,
        tts_language=body.tts_language,
        narration_tone=body.narration_tone,
        tts_voice_style=body.tts_voice_style,
        voice_gender=body.voice_gender,
        hf_tts_repo_id=effective_tts_repo_id(body.hf_tts_repo_id),
        hf_image_repo_id=effective_image_repo_id(body.hf_image_repo_id),
        image_style=(body.image_style or "").strip().lower() or None,
        script_use_web_research=web_r,
        no_image_mode=no_img,
        status=ProjectStatus.draft,
        is_active=act,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("", response_model=list[VideoProjectRead])
def list_projects(db: Session = Depends(get_db), current: User = Depends(get_current_user)) -> list[VideoProject]:
    rows = db.execute(select(VideoProject).where(VideoProject.user_id == current.id)).scalars().all()
    return list(rows)


@router.get("/{project_id}", response_model=VideoProjectRead)
def get_project(
    project_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> VideoProject:
    return _get_owned_project(db, current.id, project_id)


@router.put("/{project_id}", response_model=VideoProjectRead)
def update_project(
    project_id: str,
    body: VideoProjectUpdate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> VideoProject:
    project = _get_owned_project(db, current.id, project_id)

    if body.series_id is not None:
        if body.series_id:
            series = db.get(Series, body.series_id)
            if not series or series.user_id != current.id:
                raise HTTPException(status_code=400, detail="Invalid series_id")
        project.series_id = body.series_id
    if body.title is not None:
        project.title = body.title
    if body.theme is not None:
        project.theme = body.theme
    if body.max_duration_seconds is not None:
        project.max_duration_seconds = body.max_duration_seconds
    if body.video_type is not None:
        project.video_type = body.video_type
    if body.content_notes is not None:
        project.content_notes = body.content_notes
    if body.include_subtitles is not None:
        project.include_subtitles = body.include_subtitles
    if body.use_ai_video_title is not None:
        project.use_ai_video_title = body.use_ai_video_title
    if body.script_use_web_research is not None:
        project.script_use_web_research = body.script_use_web_research
    if body.no_image_mode is not None:
        project.no_image_mode = body.no_image_mode
    if body.episode_topic is not None:
        project.episode_topic = body.episode_topic
    if body.topic_dedup_recent_count is not None:
        project.topic_dedup_recent_count = int(body.topic_dedup_recent_count)
    if body.is_active is not None:
        project.is_active = body.is_active
    if body.tts_speaker is not None:
        project.tts_speaker = body.tts_speaker
    if body.tts_language is not None:
        project.tts_language = body.tts_language
    if body.narration_tone is not None:
        project.narration_tone = body.narration_tone
    if body.tts_voice_style is not None:
        project.tts_voice_style = body.tts_voice_style
    if body.voice_gender is not None:
        project.voice_gender = body.voice_gender
    if body.hf_tts_repo_id is not None:
        project.hf_tts_repo_id = effective_tts_repo_id(body.hf_tts_repo_id)
    if body.hf_image_repo_id is not None:
        project.hf_image_repo_id = effective_image_repo_id(body.hf_image_repo_id)
    if body.image_style is not None:
        project.image_style = (body.image_style or "").strip().lower() or None

    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> None:
    project = _get_owned_project(db, current.id, project_id)
    db.delete(project)
    db.commit()


@router.post("/{project_id}/generate", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def start_generation(
    project_id: str,
    post_publish: bool = Query(False, description="False = output locally without upload; True = full publish path."),
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Job:
    project = _get_owned_project(db, current.id, project_id)
    return enqueue_pipeline_job(db, project, post_publish=post_publish, source="api:generate")
