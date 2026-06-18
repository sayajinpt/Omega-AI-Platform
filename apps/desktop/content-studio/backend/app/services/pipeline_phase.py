"""Persist render phase on the job payload for agent polling (images → TTS → ffmpeg → done)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import Job


def set_pipeline_phase(db: Session, job_id: str, phase: str) -> None:
    """Update ``pipeline_phase`` on the job payload (``images`` | ``tts`` | ``ffmpeg`` | ``done``)."""
    jid = job_id.strip()
    ph = phase.strip().lower()
    if not jid or not ph:
        return
    job = db.get(Job, jid)
    if not job:
        return
    payload = dict(job.payload) if isinstance(job.payload, dict) else {}
    payload["pipeline_phase"] = ph
    job.payload = payload
    db.add(job)
    db.commit()
