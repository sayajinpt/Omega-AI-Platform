"""
Local integration API for external agents (Hermes, Ollama orchestrators, etc.).

Default: **no authentication** — bind uvicorn to ``127.0.0.1`` only. Uses the same DB user
as the desktop app. Optional lock-down: ``INTEGRATION_AUTH_REQUIRED=true`` + ``INTEGRATION_API_KEY``.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_integration_or_current_user
from app.config import settings
from app.database import get_db
from app.models import Job, JobLog, User, VideoProject
from app.models.enums import JobStatus, ProjectStatus, VideoType
from app.models import Schedule, Series
from app.schemas import (
    AgentJobStatus,
    AgentPipelineMode,
    AgentProjectSummary,
    AgentRunContent,
    AgentRunCreate,
    AgentRunCreated,
    AgentVideoDeliverable,
    ScheduleCreate,
    ScheduleRead,
    SeriesCreate,
    SeriesRead,
)
from app.services.agent_content import (
    build_agent_job_content,
    build_agent_job_status,
    count_user_projects,
    latest_script_for_project,
)
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.duration_policy import normalize_duration_seconds
from app.services.video_format_resolver import resolve_video_type
from app.services.job_cancel import mark_job_cancelled, request_job_cancel
from app.workers.queue import kill_pipeline_job
from app.services.pipeline_jobs import enqueue_pipeline_job

router = APIRouter(prefix="/agent/v1", tags=["agent-integration"])


class GpuUnloadBody(BaseModel):
    reason: str = Field(default="omega_request", max_length=120)
    force: bool = False


@router.post("/gpu/unload")
def agent_gpu_unload(body: GpuUnloadBody | None = None) -> dict[str, str | bool]:
    """Clear TTS/image pipelines and CUDA cache in the Content Studio API worker."""
    from app.workers.queue import any_pipeline_worker_running

    reason = (body.reason if body else "omega_request") or "omega_request"
    force = bool(body.force if body else False) or reason == "user_stop" or reason.startswith(
        "cancel:"
    )
    if any_pipeline_worker_running() and not force:
        return {
            "ok": False,
            "skipped": True,
            "detail": (
                "Pipeline worker still running — skipped GPU unload so diffusion is not torn down mid-step. "
                "Stop the job first or wait until it finishes."
            ),
        }
    try:
        from app.services.gpu_release import release_generation_gpu

        detail = release_generation_gpu(reason=reason)
        return {"ok": True, "detail": detail}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"gpu unload: {exc}",
        ) from exc


def _get_owned_job(db: Session, user: User, job_id: str) -> Job:
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    project = db.get(VideoProject, job.project_id)
    if not project or project.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job


def _get_owned_project(db: Session, user: User, project_id: str) -> VideoProject:
    project = db.get(VideoProject, project_id)
    if not project or project.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _resolve_pipeline_flags(mode: str) -> tuple[bool, bool, bool, str | None]:
    """Return (post_publish, skip_local_media, skip_llm_script, deliverable)."""
    m = (mode or AgentPipelineMode.SCRIPT_ONLY).strip().lower()
    if m in ("full_publish", "publish", "full"):
        return True, False, False, "video"
    if m in ("local_media", "local", "media", "render", "video"):
        return False, False, False, "video"
    if m in ("image_only", "image"):
        return False, False, False, "image_only"
    if m in ("audio_only", "audio"):
        return False, False, False, "audio_only"
    if m in ("script_only", "script", "text"):
        return False, True, False, None
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="pipeline_mode must be script_only, local_media, full_publish, image_only, or audio_only",
    )


def _resolve_include_subtitles(body: AgentRunCreate, *, duration: int, video_type: VideoType) -> bool:
    if body.include_subtitles is not None:
        return bool(body.include_subtitles)
    if video_type == VideoType.youtube_shorts_vertical and duration <= 120:
        return True
    return False


def _merge_agent_content_notes(body: AgentRunCreate) -> str | None:
    parts: list[str] = []
    if (body.content_notes or "").strip():
        parts.append(body.content_notes.strip())
    if (body.subtitle_language or "").strip():
        parts.append(f"Subtitle language: {body.subtitle_language.strip()}")
    return "\n".join(parts) if parts else None


def _create_project_from_agent(body: AgentRunCreate, user: User) -> VideoProject:
    title = (body.title or "").strip() or "Agent run"
    theme = (body.theme or "").strip()
    fmt_hint = (body.video_format or "").strip() or None
    try:
        dur = normalize_duration_seconds(body.max_duration_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    vt = body.video_type or resolve_video_type(
        theme=theme,
        video_format=fmt_hint,
        image_style=(body.image_style or "").strip().lower() or None,
        max_duration_seconds=dur,
    )
    return VideoProject(
        user_id=user.id,
        title=title[:255],
        theme=theme,
        max_duration_seconds=dur,
        video_type=vt,
        content_notes=_merge_agent_content_notes(body),
        episode_topic=(body.episode_topic or "").strip() or None,
        include_subtitles=_resolve_include_subtitles(body, duration=dur, video_type=vt),
        use_ai_video_title=bool(body.use_ai_video_title),
        script_use_web_research=bool(body.script_use_web_research),
        no_image_mode=bool(body.no_image_mode),
        tts_speaker=(body.tts_speaker or "Ryan").strip()[:64],
        tts_language=(body.tts_language or "English").strip()[:64],
        narration_tone=(body.narration_tone or "").strip() or None,
        voice_gender=(body.voice_gender or "any").strip()[:32],
        image_style=(body.image_style or "").strip().lower() or None,
        tts_voice_style=body.tts_voice_style,
        hf_tts_repo_id=effective_tts_repo_id(None),
        hf_image_repo_id=effective_image_repo_id(None),
        status=ProjectStatus.draft,
        is_active=True,
    )


def _wait_for_job(db: Session, job_id: str, *, timeout_seconds: int) -> Job:
    deadline = time.monotonic() + max(1, min(int(timeout_seconds), 900))
    while time.monotonic() < deadline:
        db.expire_all()
        job = db.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
            return job
        time.sleep(2.0)
    raise HTTPException(
        status_code=status.HTTP_408_REQUEST_TIMEOUT,
        detail="Job still running; poll GET /agent/v1/runs/{job_id} or increase wait_seconds.",
    )


@router.get("/generation/capabilities")
def generation_capabilities(
    modality: str,
    repo_id: str,
) -> dict[str, object]:
    """Runtime capability probe for a user-pinned HF generation model."""
    from app.services.generation_capabilities import probe_generation_capabilities

    mod = modality.strip().lower()
    rid = repo_id.strip()
    if mod not in ("tts", "image", "video"):
        raise HTTPException(status_code=400, detail="modality must be tts, image, or video")
    if not rid:
        raise HTTPException(status_code=400, detail="repo_id required")
    return probe_generation_capabilities(mod, rid)  # type: ignore[arg-type]


@router.get("/generation/catalog")
def generation_catalog() -> dict[str, object]:
    """TTS / image model lists for Omega Content Studio UI."""
    from localgen.installed_models import list_models_for_ui
    from localgen.paths import get_models_root
    from localgen.registry import (
        DEFAULT_IMAGE_REPO_ID,
        DEFAULT_TTS_REPO_ID,
        studio_suggested_image_catalog,
        studio_suggested_tts_catalog,
    )

    def _entries(cat: dict) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for key, meta in cat.items():
            out.append(
                {
                    "key": key,
                    "repo_id": str(meta.get("id") or key),
                    "description": str(meta.get("description") or ""),
                    "size": str(meta.get("size") or ""),
                }
            )
        return out

    def _installed_entries(kind: str) -> list[dict[str, str | bool]]:
        rows = list_models_for_ui(kind)  # type: ignore[arg-type]
        return [
            {
                "key": label,
                "repo_id": repo_id,
                "description": "",
                "on_disk": on_disk,
            }
            for repo_id, label, on_disk in rows
            if on_disk
        ]

    suggested_tts = _entries(studio_suggested_tts_catalog())
    suggested_image = _entries(studio_suggested_image_catalog())

    return {
        "defaults": {"tts": DEFAULT_TTS_REPO_ID, "image": DEFAULT_IMAGE_REPO_ID},
        "suggested_tts_models": suggested_tts,
        "suggested_image_models": suggested_image,
        "tts_models": suggested_tts,
        "image_models": suggested_image,
        "installed_tts": _installed_entries("tts"),
        "installed_image": _installed_entries("image"),
        "models_root": str(get_models_root()),
        "script_modes": ["content_studio", "omega_agent", "agent_orchestrated"],
        "active": {
            "tts": effective_tts_repo_id(None),
            "image": effective_image_repo_id(None),
            "script_mode": (settings.content_script_mode or "content_studio").strip(),
            "omega_model_id": (settings.content_omega_model_id or "").strip(),
        },
    }


@router.get("/info")
def agent_info() -> dict[str, str | bool]:
    """Capability discovery for external orchestrators."""
    from app.workers.queue import any_pipeline_worker_running

    auth_required = bool(settings.integration_auth_required)
    return {
        "api_version": "v1",
        "pipeline_worker_busy": any_pipeline_worker_running(),
        "auth_required": auth_required,
        "integration_key_configured": bool((settings.integration_api_key or "").strip()),
        "webhook_configured": bool((settings.agent_webhook_url or "").strip()),
        "auth": (
            "none (local default)"
            if not auth_required
            else "X-Integration-Api-Key or Authorization: Bearer <integration_api_key> or JWT"
        ),
        "create_run": "POST /api/agent/v1/runs",
        "poll_status": "GET /api/agent/v1/runs/{job_id}",
        "fetch_content": "GET /api/agent/v1/runs/{job_id}/content",
        "gpu_unload": "POST /api/agent/v1/gpu/unload",
        "webhook_event": "job.finished (POST to webhook_url or AGENT_WEBHOOK_URL)",
    }


@router.get("/projects", response_model=list[AgentProjectSummary])
def list_projects(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> list[AgentProjectSummary]:
    """List recent projects for the authenticated user (newest first)."""
    try:
        rows = (
            db.execute(
                select(VideoProject)
                .where(VideoProject.user_id == current.id)
                .order_by(VideoProject.updated_at.desc())
                .limit(limit)
            )
            .scalars()
            .all()
        )
        return [
            AgentProjectSummary(
                id=p.id,
                title=(p.title or "Untitled")[:255],
                theme=(p.theme or "")[:500],
                status=p.status.value if hasattr(p.status, "value") else str(p.status),
                updated_at=p.updated_at,
            )
            for p in rows
        ]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"projects: {exc}",
        ) from exc


@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> None:
    """Delete a project (integration auth — same as create_run, no JWT required on localhost)."""
    project = _get_owned_project(db, current, project_id)
    db.delete(project)
    db.commit()


@router.post("/runs", response_model=AgentRunCreated, status_code=status.HTTP_202_ACCEPTED)
def create_run(
    body: AgentRunCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> AgentRunCreated:
    """
    Queue script generation (and optionally local media / YouTube publish).

    Hermes-style flow: POST here → poll ``GET .../runs/{id}`` → ``GET .../runs/{id}/content``.
  Set ``wait_seconds`` to block until finished (max 900).
    """
    from app.workers.queue import any_pipeline_worker_running

    if any_pipeline_worker_running():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "A Content Studio pipeline worker is still running. "
                "Stop the current job or wait until it finishes before starting another."
            ),
        )

    post_publish, skip_media, skip_llm, deliverable = _resolve_pipeline_flags(body.pipeline_mode)

    script_mode = (body.script_mode or settings.content_script_mode or "content_studio").strip().lower()
    script_content = body.script_content if isinstance(body.script_content, dict) else None
    if script_mode == "agent_orchestrated" and not script_content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="agent_orchestrated requires script_content (Omega agent prepares script, pipeline runs TTS/render).",
        )
    if script_content:
        skip_llm = True

    if body.project_id:
        project = _get_owned_project(db, current, body.project_id)
        if (body.voice_gender or "").strip():
            project.voice_gender = body.voice_gender.strip()[:32]
        if (body.narration_tone or "").strip():
            project.narration_tone = body.narration_tone.strip() or None
        if (body.tts_language or "").strip():
            project.tts_language = body.tts_language.strip()[:64]
        if (body.tts_speaker or "").strip():
            project.tts_speaker = body.tts_speaker.strip()[:64]
        if body.tts_voice_style is not None:
            project.tts_voice_style = body.tts_voice_style
        if body.max_duration_seconds is not None:
            try:
                project.max_duration_seconds = normalize_duration_seconds(body.max_duration_seconds)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        db.add(project)
        db.commit()
        db.refresh(project)
    else:
        project = _create_project_from_agent(body, current)
        db.add(project)
        db.commit()
        db.refresh(project)

    job = enqueue_pipeline_job(
        db,
        project,
        post_publish=post_publish,
        skip_local_media=skip_media,
        skip_llm_script=skip_llm,
        deliverable=deliverable,
        source="api:agent:orchestrated" if script_mode == "agent_orchestrated" else "api:agent",
        webhook_url=body.webhook_url,
        agent_script_content=script_content,
        script_mode=script_mode,
        reuse_images_from_job_id=(body.reuse_images_from_job_id or "").strip() or None,
        use_native_media=body.use_native_media,
    )

    prefix = settings.api_prefix.rstrip("/")
    created = AgentRunCreated(
        job_id=job.id,
        project_id=project.id,
        status=job.status.value if hasattr(job.status, "value") else str(job.status),
        poll_url=f"{prefix}/agent/v1/runs/{job.id}",
        content_url=f"{prefix}/agent/v1/runs/{job.id}/content",
    )

    if body.wait_seconds and body.wait_seconds > 0:
        job = _wait_for_job(db, job.id, timeout_seconds=body.wait_seconds)
        created.status = job.status.value if hasattr(job.status, "value") else str(job.status)

    return created


@router.post("/runs/{job_id}/cancel", response_model=AgentJobStatus)
def cancel_run(
    job_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> AgentJobStatus:
    """Stop a queued or running pipeline job and release GPU memory in the worker."""
    job = _get_owned_job(db, current, job_id)
    if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
        data = build_agent_job_status(db, job, log_limit=20)
        return AgentJobStatus(**data)
    request_job_cancel(job_id)
    killed = kill_pipeline_job(job_id)
    try:
        from app.services.pipeline_job_pipes import dispose_job_image_pipe

        dispose_job_image_pipe(job_id)
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.workers.queue import force_mark_worker_idle

        force_mark_worker_idle(job_id)
    except Exception:  # noqa: BLE001
        pass
    mark_job_cancelled(db, job_id, message="Stopped from Omega", notify_webhook=False)
    try:
        from app.services.gpu_release import release_generation_gpu

        release_generation_gpu(reason=f"cancel:{job_id}")
    except Exception:  # noqa: BLE001
        pass
    if killed:
        db.add(
            JobLog(
                job_id=job_id,
                level="warning",
                message="Pipeline worker process terminated (hard stop).",
            )
        )
        db.commit()
    else:
        db.add(
            JobLog(
                job_id=job_id,
                level="warning",
                message=(
                    "Generation stopped — GPU memory released. "
                    "A background worker thread may still exit shortly."
                ),
            )
        )
        db.commit()
    db.refresh(job)
    data = build_agent_job_status(db, job, log_limit=20)
    return AgentJobStatus(**data)


@router.get("/runs/{job_id}", response_model=AgentJobStatus)
def get_run_status(
    job_id: str,
    log_limit: int = Query(40, ge=0, le=200),
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> AgentJobStatus:
    job = _get_owned_job(db, current, job_id)
    data = build_agent_job_status(db, job, log_limit=log_limit)
    return AgentJobStatus(**data)


@router.get("/runs/{job_id}/content", response_model=AgentRunContent)
def get_run_content(
    job_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> AgentRunContent:
    """Return script JSON and artifact paths when the job has finished."""
    job = _get_owned_job(db, current, job_id)
    if job.status == JobStatus.running or job.status == JobStatus.queued:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job still in progress; poll GET /agent/v1/runs/{job_id} until status is succeeded or failed.",
        )
    try:
        raw = build_agent_job_content(db, job)
    except ValueError as exc:
        if str(exc) == "job_not_finished":
            raise HTTPException(status_code=409, detail="Job not finished") from exc
        raise
    return AgentRunContent(
        job_id=raw["job_id"],
        project_id=raw["project_id"],
        status=raw["status"],
        project=raw["project"],
        script=raw.get("script"),
        brief=raw.get("brief"),
        video=AgentVideoDeliverable(**raw.get("video", {})),
        artifacts=raw.get("artifacts") or {},
    )


@router.get("/projects/{project_id}/content")
def get_project_content(
    project_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, object]:
    """Latest script JSON for a project (no job id required)."""
    project = _get_owned_project(db, current, project_id)
    script = latest_script_for_project(db, project.id)
    if script is None:
        raise HTTPException(status_code=404, detail="No script generated for this project yet.")
    return {
        "project_id": project.id,
        "title": project.title,
        "status": project.status.value if hasattr(project.status, "value") else str(project.status),
        "script": script,
    }


@router.get("/stats")
def agent_stats(
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> dict[str, int]:
    return {"project_count": count_user_projects(db, current.id)}


@router.get("/schedules", response_model=list[ScheduleRead])
def agent_list_schedules(
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> list[Schedule]:
    from sqlalchemy import or_

    q = (
        select(Schedule)
        .outerjoin(VideoProject, Schedule.project_id == VideoProject.id)
        .outerjoin(Series, Schedule.series_id == Series.id)
        .where(or_(VideoProject.user_id == current.id, Series.user_id == current.id))
    )
    return list(db.scalars(q).unique().all())


@router.post("/schedules", response_model=ScheduleRead, status_code=status.HTTP_201_CREATED)
def agent_create_schedule(
    body: ScheduleCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> Schedule:
    if body.series_id:
        series = db.get(Series, body.series_id)
        if not series or series.user_id != current.id:
            raise HTTPException(status_code=400, detail="Invalid series_id")
    else:
        project = db.get(VideoProject, body.project_id or "")
        if not project or project.user_id != current.id:
            raise HTTPException(status_code=400, detail="Invalid project_id")
    schedule = Schedule(
        project_id=body.project_id,
        series_id=body.series_id,
        cron_expression=body.cron_expression,
        timezone=body.timezone,
        is_active=body.is_active,
        effective_from_utc=body.effective_from_utc,
        runs_until_utc=body.runs_until_utc,
        max_runs=body.max_runs,
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    return schedule


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
def agent_delete_schedule(
    schedule_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> None:
    schedule = db.get(Schedule, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if schedule.project_id:
        _get_owned_project(db, current, schedule.project_id)
    elif schedule.series_id:
        series = db.get(Series, schedule.series_id)
        if not series or series.user_id != current.id:
            raise HTTPException(status_code=404, detail="Schedule not found")
    db.delete(schedule)
    db.commit()


@router.get("/series", response_model=list[SeriesRead])
def agent_list_series(
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> list[Series]:
    rows = db.execute(
        select(Series).where(Series.user_id == current.id).order_by(Series.updated_at.desc())
    ).scalars().all()
    return list(rows)


@router.post("/series", response_model=SeriesRead, status_code=status.HTTP_201_CREATED)
def agent_create_series(
    body: SeriesCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
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


@router.delete("/series/{series_id}", status_code=status.HTTP_204_NO_CONTENT)
def agent_delete_series(
    series_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_integration_or_current_user),
) -> None:
    series = db.get(Series, series_id)
    if not series or series.user_id != current.id:
        raise HTTPException(status_code=404, detail="Series not found")
    db.delete(series)
    db.commit()
