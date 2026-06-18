"""Cooperative cancellation for in-process pipeline jobs."""

from __future__ import annotations

import threading
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import Job, JobLog
from app.models.enums import JobStatus, ProjectStatus
from app.services.agent_webhooks import notify_agent_job_finished

_lock = threading.Lock()
_cancel_requested: set[str] = set()


class JobCancelledError(RuntimeError):
    """Raised when the user or API requested stop for a pipeline job."""


def request_job_cancel(job_id: str) -> None:
    with _lock:
        _cancel_requested.add(job_id.strip())


def clear_job_cancel(job_id: str) -> None:
    with _lock:
        _cancel_requested.discard(job_id.strip())


def is_job_cancel_requested(job_id: str) -> bool:
    with _lock:
        return job_id.strip() in _cancel_requested


def mark_job_cancelled(
    db: Session,
    job_id: str,
    *,
    message: str = "Cancelled by user",
    notify_webhook: bool = True,
) -> None:
    """Persist cancelled status. Keeps the in-memory cancel flag until the worker thread exits."""
    job = db.get(Job, job_id)
    if not job:
        return
    if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
        if notify_webhook and job.status == JobStatus.cancelled:
            notify_agent_job_finished(job_id)
        return
    job.status = JobStatus.cancelled
    job.updated_at = datetime.now(timezone.utc)
    db.add(JobLog(job_id=job.id, level="warning", message=message))
    project = job.project
    if project and project.status == ProjectStatus.generating:
        project.status = ProjectStatus.draft
        db.add(project)
    db.commit()
    if notify_webhook:
        notify_agent_job_finished(job_id)
        clear_job_cancel(job_id)


def finish_job_cancel(job_id: str) -> None:
    """Worker thread finished after cancellation — clear the cooperative flag."""
    clear_job_cancel(job_id)


def ensure_not_cancelled(db: Session, job_id: str) -> None:
    if not is_job_cancel_requested(job_id):
        return
    job = db.get(Job, job_id)
    if job and job.status not in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
        job.status = JobStatus.cancelled
        job.updated_at = datetime.now(timezone.utc)
        db.add(JobLog(job_id=job.id, level="warning", message="Cancelled by user"))
        db.commit()
    raise JobCancelledError(f"Job {job_id} cancelled")


def release_worker_gpu(reason: str, *, job_id: str | None = None) -> None:
    if job_id:
        try:
            from app.workers.queue import kill_pipeline_job

            kill_pipeline_job(job_id)
        except Exception:  # noqa: BLE001
            pass
    try:
        from app.services.gpu_release import release_generation_gpu

        release_generation_gpu(reason=reason)
    except Exception:  # noqa: BLE001
        pass
