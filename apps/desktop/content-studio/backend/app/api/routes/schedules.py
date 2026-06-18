from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.database import get_db
from app.models import Schedule, Series, User, VideoProject
from app.schemas import ScheduleCreate, ScheduleRead
from app.services.episode_factory import create_series_episode_project
from app.services.pipeline_jobs import enqueue_pipeline_job

router = APIRouter(prefix="/schedules", tags=["schedules"])


def _project_owned(db: Session, user_id: str, project_id: str) -> VideoProject:
    project = db.get(VideoProject, project_id)
    if not project or project.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


def _series_owned(db: Session, user_id: str, series_id: str) -> Series:
    series = db.get(Series, series_id)
    if not series or series.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Series not found")
    return series


@router.post("", response_model=ScheduleRead, status_code=status.HTTP_201_CREATED)
def create_schedule(
    body: ScheduleCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Schedule:
    if body.series_id:
        _series_owned(db, current.id, body.series_id)
    else:
        _project_owned(db, current.id, body.project_id or "")
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


@router.get("", response_model=list[ScheduleRead])
def list_schedules(
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> list[Schedule]:
    q = (
        select(Schedule)
        .outerjoin(VideoProject, Schedule.project_id == VideoProject.id)
        .outerjoin(Series, Schedule.series_id == Series.id)
        .where(or_(VideoProject.user_id == current.id, Series.user_id == current.id))
    )
    rows = db.scalars(q).unique().all()
    return list(rows)


def _owned_schedule(db: Session, user_id: str, schedule_id: str) -> Schedule:
    schedule = db.get(Schedule, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if schedule.project_id:
        _project_owned(db, user_id, schedule.project_id)
    elif schedule.series_id:
        _series_owned(db, user_id, schedule.series_id)
    else:
        raise HTTPException(status_code=400, detail="Invalid schedule ownership")
    return schedule


@router.put("/{schedule_id}", response_model=ScheduleRead)
def update_schedule(
    schedule_id: str,
    body: ScheduleCreate,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Schedule:
    schedule = _owned_schedule(db, current.id, schedule_id)
    if body.series_id:
        _series_owned(db, current.id, body.series_id)
    elif body.project_id:
        _project_owned(db, current.id, body.project_id)
    schedule.project_id = body.project_id
    schedule.series_id = body.series_id
    schedule.cron_expression = body.cron_expression
    schedule.timezone = body.timezone
    schedule.is_active = body.is_active
    schedule.effective_from_utc = body.effective_from_utc
    schedule.runs_until_utc = body.runs_until_utc
    schedule.max_runs = body.max_runs
    db.commit()
    db.refresh(schedule)
    return schedule


@router.post("/{schedule_id}/pause", response_model=ScheduleRead)
def pause_schedule(
    schedule_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> Schedule:
    schedule = _owned_schedule(db, current.id, schedule_id)
    schedule.is_active = False
    db.commit()
    db.refresh(schedule)
    return schedule


@router.post("/{schedule_id}/run-now", status_code=status.HTTP_202_ACCEPTED)
def run_now(
    schedule_id: str,
    db: Session = Depends(get_db),
    current: User = Depends(get_current_user),
) -> dict[str, str]:
    schedule = _owned_schedule(db, current.id, schedule_id)
    if schedule.series_id:
        series = _series_owned(db, current.id, schedule.series_id)
        project = create_series_episode_project(db, series)
        series.schedule_completed_runs += 1
        db.add(series)
        job = enqueue_pipeline_job(db, project, post_publish=True, source=f"api:schedule_run_now:{schedule_id}")
        return {"detail": "Queued series episode", "schedule_id": schedule_id, "job_id": job.id}
    project = _project_owned(db, current.id, schedule.project_id or "")
    job = enqueue_pipeline_job(db, project, post_publish=True, source=f"api:schedule_run_now:{schedule_id}")
    return {"detail": "Queued publish pipeline", "schedule_id": schedule_id, "job_id": job.id}
