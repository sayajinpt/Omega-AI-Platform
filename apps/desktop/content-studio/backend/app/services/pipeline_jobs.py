"""Create queued pipeline jobs with a consistent payload snapshot."""

from __future__ import annotations

import os

from sqlalchemy.orm import Session

from app.models import Job, JobLog, VideoProject
from app.models.enums import JobStatus, JobType
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.native_media_policy import should_use_native_media
from app.workers.queue import submit_pipeline_job


def build_image_settings_snapshot() -> dict[str, str]:
    """Capture Omega image overrides at job queue time (subprocess workers may miss live PUT /credentials)."""
    from app.config import settings

    snap: dict[str, str] = {}
    steps = (getattr(settings, "image_steps_by_repo_json", "") or "").strip()
    if steps:
        snap["image_steps_by_repo_json"] = steps
    repo = (getattr(settings, "default_hf_image_repo_id", "") or "").strip()
    if repo:
        snap["default_hf_image_repo_id"] = repo
    global_steps = int(getattr(settings, "image_num_steps", 0) or 0)
    if global_steps > 0:
        snap["image_num_steps"] = str(global_steps)
    return snap


def build_job_payload_snapshot(project: VideoProject, mode: str, *, post_publish: bool) -> dict:
    """Snapshot stored on the job; the worker reloads the project for the authoritative brief."""
    return {
        "mode": mode,
        "post_publish": post_publish,
        "source": "pipeline_jobs",
        "project_snapshot": {
            "title": project.title,
            "theme": project.theme,
            "episode_topic": project.episode_topic,
            "video_type": project.video_type.value,
            "max_duration_seconds": project.max_duration_seconds,
            "content_notes": project.content_notes,
            "include_subtitles": project.include_subtitles,
            "use_ai_video_title": project.use_ai_video_title,
            "series_id": project.series_id,
            "tts_speaker": getattr(project, "tts_speaker", None) or "Ryan",
            "tts_language": getattr(project, "tts_language", None) or "English",
            "voice_gender": getattr(project, "voice_gender", None) or "any",
            "narration_tone_set": bool(getattr(project, "narration_tone", None)),
            "hf_tts_repo_id": effective_tts_repo_id(
                (getattr(project, "hf_tts_repo_id", None) or "").strip() or None
            ),
            "hf_image_repo_id": effective_image_repo_id(
                (getattr(project, "hf_image_repo_id", None) or "").strip() or None
            ),
            "no_image_mode": bool(getattr(project, "no_image_mode", False)),
        },
    }


def enqueue_pipeline_job(
    db: Session,
    project: VideoProject,
    *,
    post_publish: bool,
    source: str = "api",
    skip_local_media: bool = False,
    skip_llm_script: bool = False,
    webhook_url: str | None = None,
    agent_script_content: dict | None = None,
    script_mode: str | None = None,
    deliverable: str | None = None,
    reuse_images_from_job_id: str | None = None,
    use_native_media: bool | None = None,
    spawn_worker: bool | None = None,
) -> Job:
    """Persist a Job row, submit to the in-process executor, append a log line."""
    mode = "full_publish" if post_publish else "full_local"
    if skip_local_media:
        mode = "script_only"
    payload = build_job_payload_snapshot(project, mode, post_publish=post_publish)
    img_snap = build_image_settings_snapshot()
    if img_snap:
        payload["image_generation_snapshot"] = img_snap
    payload["source"] = source
    payload["skip_local_media"] = bool(skip_local_media)
    payload["skip_llm_script"] = bool(skip_llm_script)
    if script_mode:
        payload["script_mode"] = script_mode.strip()
    if agent_script_content and isinstance(agent_script_content, dict):
        payload["agent_script_content"] = agent_script_content
    if deliverable:
        payload["deliverable"] = deliverable.strip().lower()
    reuse = (reuse_images_from_job_id or "").strip()
    if reuse:
        payload["reuse_images_from_job_id"] = reuse
    wh = (webhook_url or "").strip()
    if wh:
        payload["webhook_url"] = wh

    snap = payload.get("project_snapshot") or {}
    hf_tts = str(snap.get("hf_tts_repo_id") or "")
    hf_image = str(snap.get("hf_image_repo_id") or "")
    no_image = bool(snap.get("no_image_mode"))
    if use_native_media is not None:
        payload["use_native_media"] = bool(use_native_media)
    else:
        payload["use_native_media"] = should_use_native_media(
            payload, hf_tts or None, hf_image or None, no_image
        )

    job = Job(
        project_id=project.id,
        job_type=JobType.full_pipeline,
        status=JobStatus.queued,
        payload=payload,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    if spawn_worker is None:
        defer = os.environ.get("OMEGA_CS_DEFER_WORKER_SPAWN", "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        spawn_worker = not defer
    if spawn_worker:
        task_id = submit_pipeline_job(str(job.id))
        queue_msg = f"Queued ({mode}) from {source}"
    else:
        task_id = f"deferred:{job.id}"
        queue_msg = f"Queued ({mode}) from {source}; worker spawn deferred to omega-runtime"
    job.celery_task_id = task_id
    db.add(
        JobLog(
            job_id=job.id,
            level="info",
            message=queue_msg,
        )
    )
    db.commit()
    db.refresh(job)
    return job
