"""Partial pipelines: image-only or audio-only (no forced video length caps)."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models import JobLog
from app.services.local_pipeline_media import run_local_tts_for_job
from app.services.local_pipeline_sd3 import run_sd3_images_for_job
from app.services.native_media_bridge import build_native_render_body, run_native_partial_render
from app.services.native_media_policy import should_use_native_media
from app.services.video_brief import tts_instruct_from_brief_dict


def run_images_only_bundle(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    payload: dict[str, Any],
    hf_image_repo_id: str | None = None,
    image_style: str | None = None,
) -> str:
    if should_use_native_media(payload, None, hf_image_repo_id, False):
        body = build_native_render_body(
            job_id=job_id,
            project_id=project_id,
            script_content=script_content,
            brief_json=brief_json,
            payload=payload,
            hf_image_repo_id=hf_image_repo_id,
            image_style=image_style,
            deliverable="image_only",
        )
        run_native_partial_render(db, job_id=job_id, body=body)
        return "Native image pass complete | Deliverable: scene images only (no video)."

    skip_sd3 = bool(payload.get("skip_sd3"))
    line = run_sd3_images_for_job(
        db,
        job_id=job_id,
        project_id=project_id,
        script_content=script_content,
        brief_json=brief_json,
        skip_sd3=skip_sd3,
        hf_image_repo_id=hf_image_repo_id,
        image_style=image_style,
    )
    db.add(JobLog(job_id=job_id, level="info", message="Image-only deliverable: no TTS or MP4 assembly."))
    db.commit()
    return f"{line} | Deliverable: scene images only (no video)."


def run_audio_only_bundle(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    tts_speaker: str = "Ryan",
    tts_language: str = "English",
    tts_instruct: str | None = None,
    tts_voice_gender: str = "any",
    hf_tts_repo_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    payload = payload or {}
    if should_use_native_media(payload, hf_tts_repo_id, None, False):
        body = build_native_render_body(
            job_id=job_id,
            project_id=project_id,
            script_content=script_content,
            brief_json=brief_json,
            payload=payload,
            tts_speaker=tts_speaker,
            tts_language=tts_language,
            tts_instruct=tts_instruct,
            tts_voice_gender=tts_voice_gender,
            hf_tts_repo_id=hf_tts_repo_id,
            deliverable="audio_only",
        )
        run_native_partial_render(db, job_id=job_id, body=body)
        return "Native TTS pass complete | Deliverable: narration audio only (no video)."

    effective_instruct = tts_instruct_from_brief_dict(brief_json, override=tts_instruct)
    line = run_local_tts_for_job(
        db,
        job_id=job_id,
        project_id=project_id,
        script_content=script_content,
        speaker=tts_speaker,
        language=tts_language,
        instruct=effective_instruct,
        hf_tts_repo_id=hf_tts_repo_id,
        voice_gender=tts_voice_gender,
    )
    db.add(JobLog(job_id=job_id, level="info", message="Audio-only deliverable: no images or MP4."))
    db.commit()
    return f"{line} | Deliverable: narration audio only (no video)."
