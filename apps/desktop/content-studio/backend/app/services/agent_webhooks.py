"""POST job-completion payloads to Hermes or other local listeners (optional)."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import settings
from app.database import SessionLocal
from app.models import Job
from app.models.enums import JobStatus
from app.services.agent_content import build_agent_job_content

logger = logging.getLogger(__name__)


def _webhook_targets(job: Job) -> list[str]:
    urls: list[str] = []
    payload = job.payload or {}
    per_run = (payload.get("webhook_url") or "").strip()
    if per_run:
        urls.append(per_run)
    global_url = (settings.agent_webhook_url or "").strip()
    if global_url and global_url not in urls:
        urls.append(global_url)
    return urls


def _build_payload(db, job: Job) -> dict[str, Any]:
    prefix = settings.api_prefix.rstrip("/")
    base = {
        "event": "job.finished",
        "job_id": job.id,
        "project_id": job.project_id,
        "status": job.status.value if hasattr(job.status, "value") else str(job.status),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "poll_url": f"{prefix}/agent/v1/runs/{job.id}",
        "content_url": f"{prefix}/agent/v1/runs/{job.id}/content",
    }
    if job.status != JobStatus.succeeded:
        return base
    try:
        raw = build_agent_job_content(db, job)
        base["project"] = raw.get("project")
        base["script"] = raw.get("script")
        base["brief"] = raw.get("brief")
        base["artifacts"] = raw.get("artifacts")
        base["video"] = raw.get("video")
    except Exception:  # noqa: BLE001
        logger.exception("Webhook content assembly failed for job %s", job.id)
    return base


def _post_webhook(url: str, body: dict[str, Any]) -> None:
    timeout = max(1.0, float(settings.agent_webhook_timeout_seconds))
    try:
        with httpx.Client(timeout=timeout) as client:
            r = client.post(url, json=body)
            r.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agent webhook POST failed (%s): %s", url, exc)


def _deliver_job_webhooks(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if not job:
            return
        if job.status not in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
            return
        urls = _webhook_targets(job)
        if not urls:
            return
        body = _build_payload(db, job)
        for url in urls:
            _post_webhook(url, body)
    finally:
        db.close()


def notify_agent_job_finished(job_id: str) -> None:
    """Fire configured webhooks without blocking the pipeline worker."""
    threading.Thread(
        target=_deliver_job_webhooks,
        args=(job_id,),
        name=f"agent-webhook-{job_id[:8]}",
        daemon=True,
    ).start()
