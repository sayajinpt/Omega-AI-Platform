"""Evaluate cron schedules and enqueue pipeline jobs (desktop + optional API runner)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from croniter import croniter
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models import Job, Schedule, Series, VideoProject
from app.models.enums import JobStatus, JobType
from app.services.episode_factory import create_series_episode_project
from app.services.pipeline_jobs import enqueue_pipeline_job


def _safe_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo((name or "UTC").strip() or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _project_has_active_pipeline(db: Session, project_id: str) -> bool:
    row = db.execute(
        select(Job.id).where(
            Job.project_id == project_id,
            Job.job_type == JobType.full_pipeline,
            Job.status.in_((JobStatus.queued, JobStatus.running)),
        ).limit(1)
    ).first()
    return row is not None


def _series_has_active_pipeline(db: Session, series_id: str) -> bool:
    row = db.execute(
        select(Job.id)
        .join(VideoProject, Job.project_id == VideoProject.id)
        .where(
            VideoProject.series_id == series_id,
            Job.job_type == JobType.full_pipeline,
            Job.status.in_((JobStatus.queued, JobStatus.running)),
        )
        .limit(1)
    ).first()
    return row is not None


def _prev_fire_local(cron_expr: str, tz: ZoneInfo, local_now: datetime) -> datetime | None:
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return None
    try:
        itr = croniter(" ".join(parts), local_now.replace(second=0, microsecond=0))
        return itr.get_prev(datetime)
    except (ValueError, KeyError, TypeError):
        return None


def _next_fire_utc(cron_expr: str, tz: ZoneInfo, from_utc: datetime) -> datetime | None:
    parts = cron_expr.strip().split()
    if len(parts) != 5:
        return None
    try:
        local = from_utc.astimezone(tz).replace(second=0, microsecond=0)
        itr = croniter(" ".join(parts), local)
        nxt = itr.get_next(datetime)
        if nxt.tzinfo is None:
            nxt = nxt.replace(tzinfo=tz)
        return nxt.astimezone(timezone.utc)
    except (ValueError, KeyError, TypeError):
        return None


def _schedule_owned_by(sched: Schedule, user_id: str) -> bool:
    if sched.project_id and sched.project:
        return sched.project.user_id == user_id
    if sched.series_id and sched.series_obj:
        return sched.series_obj.user_id == user_id
    return False


def _deactivate_project_schedules(db: Session, project_id: str) -> None:
    for s in db.execute(select(Schedule).where(Schedule.project_id == project_id)).scalars():
        s.is_active = False
        db.add(s)
    db.commit()


def _deactivate_series_schedules(db: Session, series_id: str) -> None:
    for s in db.execute(select(Schedule).where(Schedule.series_id == series_id)).scalars():
        s.is_active = False
        db.add(s)
    db.commit()


def run_schedule_tick(db: Session, *, user_id: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    """
    For each active schedule, if a cron boundary passed since last_run and no pipeline job is
    already queued for that target, enqueue a run. Series-bound schedules create the next episode
    project first, then queue a **post_publish** pipeline job.
    """
    now_utc = now or datetime.now(timezone.utc)
    if now_utc.tzinfo is None:
        now_utc = now_utc.replace(tzinfo=timezone.utc)

    q = (
        select(Schedule)
        .where(Schedule.is_active.is_(True))
        .options(selectinload(Schedule.project), selectinload(Schedule.series_obj))
    )
    schedules = list(db.execute(q).scalars().all())
    if user_id:
        schedules = [s for s in schedules if _schedule_owned_by(s, user_id)]

    enqueued: list[dict[str, str]] = []
    errors: list[str] = []

    for sched in schedules:
        if sched.effective_from_utc is not None:
            eff = sched.effective_from_utc
            if eff.tzinfo is None:
                eff = eff.replace(tzinfo=timezone.utc)
            if now_utc < eff:
                continue

        if sched.runs_until_utc is not None:
            ru = sched.runs_until_utc
            if ru.tzinfo is None:
                ru = ru.replace(tzinfo=timezone.utc)
            if now_utc > ru:
                sched.is_active = False
                db.add(sched)
                db.commit()
                continue

        if sched.max_runs is not None and sched.run_count >= sched.max_runs:
            sched.is_active = False
            db.add(sched)
            db.commit()
            continue

        tz = _safe_tz(sched.timezone)
        local_now = now_utc.astimezone(tz)
        prev_local = _prev_fire_local(sched.cron_expression, tz, local_now)
        if prev_local is None:
            errors.append(f"schedule {sched.id}: invalid cron {sched.cron_expression!r}")
            continue

        if prev_local.tzinfo is None:
            prev_local = prev_local.replace(tzinfo=tz)

        last = sched.last_run
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)

        if last is None:
            sched.last_run = prev_local.astimezone(timezone.utc)
            sched.next_run = _next_fire_utc(sched.cron_expression, tz, now_utc + timedelta(seconds=1))
            db.add(sched)
            db.commit()
            continue

        last_local = last.astimezone(tz)
        if last_local >= prev_local:
            nxt = _next_fire_utc(sched.cron_expression, tz, now_utc + timedelta(seconds=1))
            if nxt and sched.next_run != nxt:
                sched.next_run = nxt
                db.add(sched)
                db.commit()
            continue

        if sched.series_id:
            series = sched.series_obj or db.get(Series, sched.series_id)
            if not series or not series.is_active:
                continue
            if series.schedule_runs_until_utc is not None:
                ru = series.schedule_runs_until_utc
                if ru.tzinfo is None:
                    ru = ru.replace(tzinfo=timezone.utc)
                if now_utc > ru:
                    _deactivate_series_schedules(db, series.id)
                    continue
            if series.schedule_max_runs is not None and series.schedule_completed_runs >= series.schedule_max_runs:
                _deactivate_series_schedules(db, series.id)
                continue
            if _series_has_active_pipeline(db, series.id):
                continue

            try:
                project = create_series_episode_project(db, series)
                series.schedule_completed_runs += 1
                db.add(series)
                sched.last_run = prev_local.astimezone(timezone.utc)
                sched.next_run = _next_fire_utc(sched.cron_expression, tz, now_utc + timedelta(seconds=1))
                sched.run_count += 1
                db.add(sched)
                enqueue_pipeline_job(db, project, post_publish=True, source=f"schedule:{sched.id}")
                if series.schedule_max_runs is not None and series.schedule_completed_runs >= series.schedule_max_runs:
                    _deactivate_series_schedules(db, series.id)
                enqueued.append({"schedule_id": sched.id, "project_id": project.id, "title": project.title})
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                errors.append(f"schedule {sched.id}: {exc}")
            continue

        project = sched.project or db.get(VideoProject, sched.project_id or "")
        if not project or not project.is_active:
            continue
        if project.schedule_runs_until_utc is not None:
            ru = project.schedule_runs_until_utc
            if ru.tzinfo is None:
                ru = ru.replace(tzinfo=timezone.utc)
            if now_utc > ru:
                _deactivate_project_schedules(db, project.id)
                continue
        if project.schedule_max_runs is not None and project.schedule_completed_runs >= project.schedule_max_runs:
            _deactivate_project_schedules(db, project.id)
            continue

        if _project_has_active_pipeline(db, project.id):
            continue

        try:
            project.schedule_completed_runs += 1
            db.add(project)
            sched.last_run = prev_local.astimezone(timezone.utc)
            sched.next_run = _next_fire_utc(sched.cron_expression, tz, now_utc + timedelta(seconds=1))
            sched.run_count += 1
            db.add(sched)
            enqueue_pipeline_job(db, project, post_publish=True, source=f"schedule:{sched.id}")
            if project.schedule_max_runs is not None and project.schedule_completed_runs >= project.schedule_max_runs:
                _deactivate_project_schedules(db, project.id)
            enqueued.append({"schedule_id": sched.id, "project_id": project.id, "title": project.title})
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            errors.append(f"schedule {sched.id}: {exc}")

    return {
        "checked": len(schedules),
        "enqueued": enqueued,
        "enqueued_count": len(enqueued),
        "errors": errors,
    }
