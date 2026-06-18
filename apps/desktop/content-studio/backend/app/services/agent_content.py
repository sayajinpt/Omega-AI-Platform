"""Assemble script + artifact paths for external agent consumers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Job, JobLog, Script, Video, VideoProject
from app.models.enums import JobStatus


def _storage_root() -> Path:
    return Path(settings.storage_path).expanduser().resolve()


def latest_script_for_project(db: Session, project_id: str) -> dict[str, Any] | None:
    row = db.execute(
        select(Script)
        .where(Script.project_id == project_id)
        .order_by(Script.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    if not row or not isinstance(row.content, dict):
        return None
    return dict(row.content)


def _relative_storage_path(path: Path) -> str:
    try:
        return str(path.relative_to(_storage_root())).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def find_mp4_for_job(project_id: str, job_id: str) -> str | None:
    """Return only the canonical job-root deliverable (never partial segment MP4s)."""
    base = _storage_root() / project_id / job_id
    for name in ("final.mp4", "output.mp4", "video.mp4"):
        p = base / name
        if p.is_file() and p.stat().st_size > 0:
            return _relative_storage_path(p)
    return None


def job_log_tail(db: Session, job_id: str, *, limit: int = 40) -> list[dict[str, str]]:
    rows = db.execute(
        select(JobLog)
        .where(JobLog.job_id == job_id)
        .order_by(JobLog.created_at.desc())
        .limit(max(1, min(limit, 200)))
    ).scalars().all()
    out: list[dict[str, str]] = []
    for row in reversed(rows):
        msg = str(row.message or "")
        if "\n" in msg or "\r" in msg:
            msg = " ".join(msg.split())
        out.append(
            {
                "level": str(row.level or "info"),
                "message": msg,
                "created_at": row.created_at.isoformat() if row.created_at else "",
            }
        )
    return out


def build_agent_job_status(db: Session, job: Job, *, log_limit: int = 40) -> dict[str, Any]:
    project = db.get(VideoProject, job.project_id)
    logs = job_log_tail(db, job.id, limit=log_limit)
    err_msg = ""
    if job.status == JobStatus.failed:
        for entry in reversed(logs):
            if entry.get("level") == "error":
                err_msg = entry.get("message", "")
                break
        if not err_msg and logs:
            err_msg = logs[-1].get("message", "")

    script_ready = latest_script_for_project(db, job.project_id) is not None
    worker_running = False
    try:
        from app.workers.queue import is_pipeline_worker_running

        worker_running = is_pipeline_worker_running(job.id)
    except Exception:  # noqa: BLE001
        pass
    mp4 = find_mp4_for_job(job.project_id, job.id) if job.status == JobStatus.succeeded else None
    if worker_running:
        mp4 = None

    yt_url: str | None = None
    if job.status == JobStatus.succeeded and project and not worker_running:
        vid = db.execute(
            select(Video)
            .where(Video.project_id == project.id)
            .order_by(Video.created_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if vid and vid.youtube_url:
            yt_url = str(vid.youtube_url)

    payload = job.payload if isinstance(job.payload, dict) else {}
    pipeline_phase = str(payload.get("pipeline_phase") or "").strip().lower() or None
    deliverable = str(payload.get("deliverable") or "").strip().lower() or None
    wants_video = (
        not payload.get("skip_local_media")
        and (payload.get("deliverable") or "video").strip().lower() == "video"
    )
    status_out = job.status.value if hasattr(job.status, "value") else str(job.status)
    if (
        job.status == JobStatus.succeeded
        and wants_video
        and not mp4
        and not worker_running
    ):
        status_out = "failed"
        if not err_msg:
            err_msg = (
                "Render finished without an MP4 — the pipeline worker may not have run. "
                "Check workers/<job-id>.log under your Omega profile content-studio folder."
            )
    return {
        "job_id": job.id,
        "project_id": job.project_id,
        "status": status_out,
        "worker_running": worker_running,
        "pipeline_phase": pipeline_phase,
        "deliverable": deliverable,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "project_status": (
            project.status.value if project and hasattr(project.status, "value") else (str(project.status) if project else None)
        ),
        "script_ready": script_ready,
        "video_ready": bool(mp4) and not worker_running,
        "mp4_path": mp4,
        "youtube_url": yt_url,
        "pipeline_mode": payload.get("mode"),
        "error_message": err_msg or None,
        "logs": logs,
    }


def build_agent_job_content(db: Session, job: Job) -> dict[str, Any]:
    """Full deliverables for a completed (or partially completed) job."""
    if job.status not in (JobStatus.succeeded, JobStatus.failed):
        raise ValueError("job_not_finished")

    project = db.get(VideoProject, job.project_id)
    script = latest_script_for_project(db, job.project_id)
    payload = job.payload if isinstance(job.payload, dict) else {}
    brief = payload.get("video_brief") if isinstance(payload.get("video_brief"), dict) else None

    gen_dir = _storage_root() / job.project_id / job.id / "generation"
    artifacts: dict[str, str | None] = {
        "script_json": _relative_storage_path(gen_dir / "script.json") if (gen_dir / "script.json").is_file() else None,
        "script_txt": _relative_storage_path(gen_dir / "script.txt") if (gen_dir / "script.txt").is_file() else None,
        "brief_txt": _relative_storage_path(gen_dir / "brief.txt") if (gen_dir / "brief.txt").is_file() else None,
    }

    return {
        "job_id": job.id,
        "project_id": job.project_id,
        "status": job.status.value if hasattr(job.status, "value") else str(job.status),
        "project": {
            "id": project.id if project else job.project_id,
            "title": project.title if project else None,
            "theme": project.theme if project else None,
            "status": (
                project.status.value if project and hasattr(project.status, "value") else (str(project.status) if project else None)
            ),
        },
        "script": script,
        "brief": brief,
        "video": {
            "mp4_path": find_mp4_for_job(job.project_id, job.id),
            "youtube_url": build_agent_job_status(db, job, log_limit=0).get("youtube_url"),
        },
        "artifacts": artifacts,
    }


def count_user_projects(db: Session, user_id: str) -> int:
    return int(
        db.execute(select(func.count()).select_from(VideoProject).where(VideoProject.user_id == user_id)).scalar_one()
        or 0
    )
