from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.database import SessionLocal
from app.models import Job, JobLog, Script, Video, VideoProject
from app.models.enums import JobStatus, ProjectStatus, ScriptStatus, VideoStatus
from app.config import settings
from app.services.job_debug_export import write_generation_stage_bundle, write_pipeline_debug_bundle
from app.services.pipeline_deliverable import run_audio_only_bundle, run_images_only_bundle
from app.services.pipeline_render import run_local_production_bundle
from app.services.script_llm import generate_script_content
from app.services.script_llm_cursor_cli import script_llm_cursor_summary
from app.services.script_research import fetch_web_research_notes
from app.services.video_brief import build_video_brief
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.generation_run_kwargs import build_image_run_kwargs, build_tts_run_kwargs
from app.services.job_cancel import JobCancelledError, ensure_not_cancelled, finish_job_cancel
from app.services.youtube_upload import upload_mp4_if_configured


def _effective_tts_instruct(project: VideoProject, brief_json: dict) -> str | None:
    from app.services.narration_tone_presets import compose_full_narration_instruct
    from app.services.video_brief import tts_instruct_from_brief_dict

    tone = (getattr(project, "narration_tone", None) or "").strip()
    voice_style = getattr(project, "tts_voice_style", None)
    style_text = compose_full_narration_instruct(voice_style) if voice_style else ""
    if tone and style_text:
        return tone + "\n\n" + style_text
    if tone:
        return tts_instruct_from_brief_dict(brief_json, override=tone)
    if style_text:
        return style_text
    return tts_instruct_from_brief_dict(brief_json, override=None) or None


def _generation_kwargs_for_project(
    project: VideoProject, brief_json: dict
) -> tuple[dict[str, Any], dict[str, Any]]:
    tts_repo = effective_tts_repo_id((getattr(project, "hf_tts_repo_id", None) or "").strip() or None)
    image_repo = effective_image_repo_id(
        (getattr(project, "hf_image_repo_id", None) or "").strip() or None
    )
    tts_kw = build_tts_run_kwargs(
        tts_repo,
        speaker=getattr(project, "tts_speaker", None) or "Ryan",
        language=getattr(project, "tts_language", None) or "English",
        instruct=_effective_tts_instruct(project, brief_json),
        voice_gender=getattr(project, "voice_gender", None) or "any",
        brief_json=brief_json,
    )
    image_kw = build_image_run_kwargs(
        image_repo,
        image_style=(getattr(project, "image_style", None) or "").strip().lower() or None,
        brief_json=brief_json,
    )
    return tts_kw, image_kw


def _agent_script_ready(agent_script: object) -> bool:
    if not isinstance(agent_script, dict):
        return False
    inner = agent_script
    scenes = inner.get("scenes")
    if not isinstance(scenes, list):
        nested = inner.get("script") or inner.get("script_content")
        if isinstance(nested, dict) and isinstance(nested.get("scenes"), list):
            inner = nested
            scenes = inner.get("scenes")
    return isinstance(scenes, list) and len(scenes) > 0


def _degraded_render_summary(msg: str) -> bool:
    lower = msg.lower()
    markers = (
        "placeholders used",
        "silent audio placeholders",
        "tts load failed",
        "no weights found — silent",
        "missing ml python packages",
    )
    return any(m in lower for m in markers)


def _require_local_media_packages(db: Session, job_id: str) -> bool:
    """Return False and finalize as failed when torch/TTS stack is missing."""
    try:
        import torch  # noqa: F401

        from qwen_tts import Qwen3TTSModel  # noqa: F401
    except ImportError as exc:
        _finalize_job(
            db,
            job_id,
            False,
            "GPU media packages (torch, qwen-tts, diffusers) are not installed in the unified "
            f"Python venv ({exc}). Open Content Studio and run environment setup, or complete "
            "welcome Python setup, then retry the render.",
        )
        return False
    return True


def _finalize_job(db: Session, job_id: str, ok: bool, message: str) -> None:
    from app.services.omega_debug import emit_debug
    from app.services.pipeline_phase import set_pipeline_phase

    job = db.get(Job, job_id)
    if not job:
        return
    if job.status == JobStatus.cancelled:
        return
    set_pipeline_phase(db, job_id, "done")
    job.status = JobStatus.succeeded if ok else JobStatus.failed
    job.updated_at = datetime.now(timezone.utc)
    db.add(JobLog(job_id=job.id, level="info" if ok else "error", message=message))
    db.commit()
    emit_debug(
        f"job {'succeeded' if ok else 'failed'}: {message[:240]}",
        level="info" if ok else "error",
        data={"job_id": job_id, "status": job.status.value},
    )
    # Webhook is delivered from the job supervisor after the worker thread/subprocess exits
    # (see app.workers.queue) so chat never imports final.mp4 while diffusion is still running.


def _clear_job_render_artifacts(project_id: str, job_id: str) -> None:
    """Remove stale MP4/WAV/PNG from a previous attempt on the same job folder."""
    import shutil

    root = Path(settings.storage_path).expanduser().resolve() / project_id / job_id
    for name in ("final.mp4", "output.mp4", "video.mp4"):
        p = root / name
        if p.is_file():
            p.unlink(missing_ok=True)
    for sub in ("images", "audio", "segments"):
        d = root / sub
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)


def _next_script_version(db: Session, project_id: str) -> int:
    current = db.execute(select(func.coalesce(func.max(Script.version), 0)).where(Script.project_id == project_id)).scalar_one()
    return int(current) + 1


def _log_torch_device_hint(db: Session, job_id: str) -> None:
    """Explain CPU vs GPU saturation for Content Studio PyTorch workloads."""
    try:
        from localgen.torch_device import (
            accelerator_label,
            cuda_works,
            diffusers_accelerator,
            directml_works,
            image_acceleration_summary,
        )
    except ImportError:
        try:
            import torch
        except ImportError:
            return
        if torch.cuda.is_available():
            try:
                name = torch.cuda.get_device_name(0)
            except Exception:  # noqa: BLE001
                name = "cuda:0"
            db.add(
                JobLog(
                    job_id=job_id,
                    level="info",
                    message=f"PyTorch CUDA active: {name} — local TTS/image models use GPU.",
                )
            )
        else:
            ver = getattr(torch, "__version__", "?")
            db.add(
                JobLog(
                    job_id=job_id,
                    level="warning",
                    message=(
                        f"PyTorch has no CUDA ({ver}). TTS and image models fall back to CPU — "
                        "high CPU/RAM usage is expected."
                    ),
                )
            )
        db.commit()
        return

    summary = image_acceleration_summary()
    acc = diffusers_accelerator(want_gpu=True)
    label = accelerator_label(acc)
    if acc == "cuda":
        vram_note = ""
        try:
            import torch

            name = torch.cuda.get_device_name(0)
            free_b, total_b = torch.cuda.mem_get_info(0)
            vram_note = f" VRAM free {free_b // (1024 * 1024)} / {total_b // (1024 * 1024)} MiB."
        except Exception:  # noqa: BLE001
            name = "CUDA"
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message=f"Content Studio PyTorch: {label} ({name}) — TTS/image/video use GPU.{vram_note}",
            )
        )
    elif acc == "directml":
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message=(
                    f"Content Studio PyTorch: {label} — TTS/image/video use your AMD/Intel GPU via "
                    "torch-directml (Omega Vulkan build accelerates chat only)."
                ),
            )
        )
    else:
        lvl = "warning"
        extra = summary.message
        if cuda_works() or directml_works():
            lvl = "info"
        db.add(
            JobLog(
                job_id=job_id,
                level=lvl,
                message=f"Content Studio PyTorch: {label}. {extra}",
            )
        )
    db.commit()


def _log_cuda_sanity(db: Session, job_id: str) -> None:
    try:
        from localgen.cuda_sanity import cuda_sanity_report

        line = cuda_sanity_report(light=True)
        lvl = "warning" if "cuda=unavailable" in line or "SLOW_GPU_KERNEL" in line else "info"
        db.add(JobLog(job_id=job_id, level=lvl, message=f"CUDA sanity: {line}"))
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.add(JobLog(job_id=job_id, level="warning", message=f"CUDA sanity check failed: {exc}"))
        db.commit()


def _persist_script(db: Session, project: VideoProject, content: dict) -> None:
    script = Script(
        project_id=project.id,
        content=content,
        version=_next_script_version(db, project.id),
        status=ScriptStatus.draft,
    )
    db.add(script)
    db.commit()


def _run_job(job_id: str) -> str:
    from app.config import settings as app_settings
    from app.services.runtime_credentials import (
        apply_credentials,
        bootstrap_settings_from_env,
        patch_settings_object,
    )

    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if not job:
            import os
            import sys

            from app.services.omega_debug import emit_debug

            msg = (
                f"run_job abort: job {job_id!r} not found in database "
                f"(DATABASE_URL={os.environ.get('DATABASE_URL', '')!r})"
            )
            print(msg, file=sys.stderr, flush=True)
            emit_debug(msg, level="error", data={"job_id": job_id})
            return job_id
        bootstrap_settings_from_env()
        payload = job.payload or {}
        img_snap = payload.get("image_generation_snapshot")
        if isinstance(img_snap, dict):
            cred: dict[str, str] = {}
            steps = str(img_snap.get("image_steps_by_repo_json") or "").strip()
            if steps:
                cred["IMAGE_STEPS_BY_REPO_JSON"] = steps
            repo = str(img_snap.get("default_hf_image_repo_id") or "").strip()
            if repo:
                cred["DEFAULT_HF_IMAGE_REPO_ID"] = repo
            gsteps = str(img_snap.get("image_num_steps") or "").strip()
            if gsteps.isdigit() and int(gsteps) > 0:
                cred["IMAGE_NUM_STEPS"] = gsteps
            if cred:
                apply_credentials(cred)
                patch_settings_object(app_settings)
        post_publish = bool(payload.get("post_publish"))

        job.status = JobStatus.running
        job.updated_at = datetime.now(timezone.utc)
        steps_map = (getattr(settings, "image_steps_by_repo_json", "") or "").strip()
        img_repo = (getattr(settings, "default_hf_image_repo_id", "") or "").strip()
        import os

        is_isolated_worker = os.environ.get("OMEGA_CS_WORKER", "").strip() == "1"
        subprocess_jobs = is_isolated_worker or os.environ.get(
            "OMEGA_CS_JOB_SUBPROCESS", "0"
        ).strip().lower() not in ("0", "false", "no", "off")
        worker_label = (
            "subprocess"
            if is_isolated_worker
            else ("in-process thread" if not subprocess_jobs else "subprocess")
        )
        pipeline_msg = (
            "Pipeline started"
            + (f" (worker={worker_label})")
            + (f" (image_repo={img_repo!r})" if img_repo else "")
            + (f" (steps_by_repo={steps_map[:120]!r})" if steps_map else " (steps_by_repo=empty — catalog defaults)")
        )
        db.add(JobLog(job_id=job.id, level="info", message=pipeline_msg))
        db.commit()
        from app.services.omega_debug import emit_debug

        emit_debug(
            pipeline_msg,
            data={
                "job_id": job_id,
                "project_id": str(job.project_id),
                "worker": worker_label,
                "native_media": os.environ.get("OMEGA_NATIVE_MEDIA", ""),
            },
        )
        try:
            from localgen.attention_backend import configure_pytorch_sdp_backends, ensure_cuda_dll_paths

            ensure_cuda_dll_paths()
            configure_pytorch_sdp_backends()
        except Exception:  # noqa: BLE001
            pass
        _log_cuda_sanity(db, job_id)
        ensure_not_cancelled(db, job_id)

        project = db.execute(
            select(VideoProject).where(VideoProject.id == job.project_id).options(selectinload(VideoProject.series))
        ).scalar_one_or_none()
        if not project:
            raise RuntimeError("project missing for job")

        if project.status != ProjectStatus.published:
            project.status = ProjectStatus.generating
            db.add(project)
            db.commit()

        payload = job.payload or {}
        agent_script = payload.get("agent_script_content")
        script_mode = (payload.get("script_mode") or settings.content_script_mode or "content_studio").strip().lower()
        use_agent_script = _agent_script_ready(agent_script)

        brief = build_video_brief(project, db)
        _rw = getattr(project, "script_use_web_research", True)
        proj_wants_web = True if _rw is None else bool(_rw)
        glob_web = settings.script_web_research_enabled
        research_notes = ""
        if not use_agent_script and glob_web and proj_wants_web:
            research_notes = fetch_web_research_notes(brief)
        brief = brief.model_copy(update={"web_research_notes": research_notes})
        brief_json = json.loads(brief.model_dump_json())

        job.payload = {**(job.payload or {}), "video_brief": brief_json}
        db.add(job)
        db.commit()

        if research_notes.strip():
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message=f"Web research (Tavily): {len(research_notes)} chars injected into script prompt.",
                )
            )
            db.commit()
        elif not use_agent_script and not proj_wants_web:
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message=(
                        "Script source: model knowledge only — web search is turned off for this project "
                        "(enable “Search the web…” in project settings to use Tavily before generation)."
                    ),
                )
            )
            db.commit()
        elif not use_agent_script and not glob_web:
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message="Web research skipped globally (SCRIPT_WEB_RESEARCH_ENABLED=false).",
                )
            )
            db.commit()
        elif (
            not use_agent_script
            and not ((settings.tavily_api_key or os.environ.get("TAVILY_API_KEY") or "").strip())
        ):
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message=(
                        "Web research skipped — set TAVILY_API_KEY (optional) for server-side search before script LLM. "
                        "Cursor CLI cannot browse the web in non-interactive mode; research runs in this app instead."
                    ),
                )
            )
            db.commit()

        if use_agent_script:
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message="Web research skipped — Omega agent script will be used directly for render.",
                )
            )
            db.commit()

        db.add(
            JobLog(
                job_id=job.id,
                level="info",
                message=(
                    f"Video brief: type={brief.video_type} target={brief.target_duration_seconds}s "
                    f"scenes={brief.scene_count} planned_total={brief.planned_total_seconds}s "
                    f"aspect={brief.aspect_ratio}"
                ),
            )
        )
        db.commit()

        ensure_not_cancelled(db, job_id)

        force_outline = bool(payload.get("skip_llm_script")) and not use_agent_script
        if use_agent_script:
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message=(
                        f"Script supplied by Omega agent ({script_mode}); "
                        "pipeline will run images → TTS → ffmpeg (GPU models loaded in-worker)."
                    ),
                )
            )
            db.commit()
            content = agent_script
            if isinstance(agent_script, dict):
                nested = agent_script.get("script") or agent_script.get("script_content")
                if isinstance(nested, dict) and isinstance(nested.get("scenes"), list):
                    content = nested
        else:
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message=(
                        (
                            "Generating script — SCRIPT_LLM_BACKEND="
                            f"{(settings.script_llm_backend or 'auto').strip().lower()}; "
                            f"{script_llm_cursor_summary()} "
                            "(auto picks Cursor CLI when agent executable + CURSOR_API_KEY; else HTTP Chat Completions)."
                        )
                        if not force_outline
                        else "Using outline stub script (skip_llm_script)."
                    ),
                )
            )
            db.commit()
            if script_mode in ("agent_orchestrated", "omega_agent"):
                raise RuntimeError(
                    f"Script mode {script_mode} requires script_content on the job payload "
                    "(POST /api/agent/v1/runs with script_content from Omega)."
                )
            content = generate_script_content(project, brief, brief_json, force_outline_stub=force_outline)

        if not use_agent_script:
            orch = (content.get("meta") or {}).get("orchestrator")
            if orch == "outline_stub" and not force_outline:
                raise RuntimeError(
                    "Script step produced no real LLM output (empty outline stub). "
                    "Configure script generation: OPENAI_API_KEY + OPENAI_API_BASE, or install Cursor CLI (`agent`) "
                    "with CURSOR_API_KEY, or CURSOR_API_KEY + CURSOR_OPENAI_COMPATIBLE_BASE for Chat Completions. "
                    "Check the job log line that starts with “Generating script — SCRIPT_LLM_BACKEND” for diagnostics."
                )

        write_generation_stage_bundle(
            project_id=project.id,
            job_id=job.id,
            brief_json=brief_json,
            script_content=content,
            research_notes=research_notes,
        )

        if not use_agent_script and orch == "outline_stub":
            db.add(
                JobLog(
                    job_id=job.id,
                    level="warning",
                    message=(
                        "Script is outline_stub (no LLM): install Cursor CLI (`agent` on PATH or set CURSOR_CLI_PATH), "
                        "set CURSOR_API_KEY; or set OPENAI_API_KEY; or CURSOR_API_KEY + CURSOR_OPENAI_COMPATIBLE_BASE "
                        "(/v1 Chat Completions). Check the prior job log line for agent_executable / key status."
                    ),
                )
            )
            db.commit()

        if getattr(project, "use_ai_video_title", True) and content.get("title"):
            project.title = str(content["title"])[:255]
            db.add(project)

        _persist_script(db, project, content)
        ensure_not_cancelled(db, job_id)

        media_summary = ""
        mp4_path = None
        deliverable = (payload.get("deliverable") or "video").strip().lower()
        if not payload.get("skip_local_media") and deliverable not in ("image_only", "audio_only"):
            _clear_job_render_artifacts(project.id, job.id)
            db.add(
                JobLog(
                    job_id=job.id,
                    level="info",
                    message="Cleared prior render artifacts for this job (avoids stale MP4 in chat).",
                )
            )
            db.commit()
        if payload.get("skip_local_media"):
            db.add(JobLog(job_id=job.id, level="info", message="Local render skipped (skip_local_media)."))
            db.commit()
            media_summary = "Media skipped."
        elif deliverable == "image_only":
            db.add(JobLog(job_id=job.id, level="info", message="Rendering: scene images only (no TTS / MP4)."))
            db.commit()
            from app.services.pipeline_phase import set_pipeline_phase

            set_pipeline_phase(db, job.id, "images")
            _log_torch_device_hint(db, job.id)
            media_summary = run_images_only_bundle(
                db,
                job_id=job.id,
                project_id=project.id,
                script_content=content,
                brief_json=brief_json,
                payload=payload,
                hf_image_repo_id=(getattr(project, "hf_image_repo_id", None) or "").strip() or None,
                image_style=(getattr(project, "image_style", None) or "").strip().lower() or None,
            )
        elif deliverable == "audio_only":
            db.add(JobLog(job_id=job.id, level="info", message="Rendering: narration audio only (no images / MP4)."))
            db.commit()
            from app.services.pipeline_phase import set_pipeline_phase

            set_pipeline_phase(db, job.id, "tts")
            _log_torch_device_hint(db, job.id)
            tts_kw, image_kw = _generation_kwargs_for_project(project, brief_json)
            if not tts_kw.get("backend_supported"):
                db.add(
                    JobLog(
                        job_id=job.id,
                        level="warning",
                        message=(
                            "TTS capability probe: "
                            f"{tts_kw.get('unsupported_reason') or 'unsupported backend'}"
                        ),
                    )
                )
                db.commit()
            media_summary = run_audio_only_bundle(
                db,
                job_id=job.id,
                project_id=project.id,
                script_content=content,
                brief_json=brief_json,
                payload=payload,
                tts_speaker=tts_kw["speaker"],
                tts_language=tts_kw["language"],
                tts_instruct=tts_kw["instruct"],
                tts_voice_gender=tts_kw["voice_gender"],
                hf_tts_repo_id=tts_kw["hf_tts_repo_id"],
            )
        else:
            if not _require_local_media_packages(db, job_id):
                return job_id
            render_msg = "Rendering: images → TTS → ffmpeg…"
            db.add(JobLog(job_id=job.id, level="info", message=render_msg))
            db.commit()
            emit_debug(render_msg, data={"job_id": job_id, "project_id": str(project.id)})
            _log_torch_device_hint(db, job.id)
            tts_kw, image_kw = _generation_kwargs_for_project(project, brief_json)
            if not tts_kw.get("backend_supported"):
                db.add(
                    JobLog(
                        job_id=job.id,
                        level="warning",
                        message=(
                            "TTS capability probe: "
                            f"{tts_kw.get('unsupported_reason') or 'unsupported backend'}"
                        ),
                    )
                )
                db.commit()
            media_summary, mp4_path = run_local_production_bundle(
                db,
                job_id=job.id,
                project_id=project.id,
                script_content=content,
                brief_json=brief_json,
                payload=payload,
                tts_speaker=tts_kw["speaker"],
                tts_language=tts_kw["language"],
                tts_instruct=tts_kw["instruct"],
                tts_voice_gender=tts_kw["voice_gender"],
                hf_tts_repo_id=tts_kw["hf_tts_repo_id"],
                hf_image_repo_id=image_kw["hf_image_repo_id"],
                image_style=image_kw.get("image_style"),
                image_run_kwargs=image_kw,
                no_image_mode=bool(getattr(project, "no_image_mode", False)),
            )

        yt_url = None
        if mp4_path and post_publish:
            db.add(JobLog(job_id=job.id, level="info", message="Post-publish: attempting YouTube upload if OAuth is configured…"))
            db.commit()
            try:
                yt_url = upload_mp4_if_configured(
                    mp4_path,
                    title=str(content.get("title") or project.title),
                    description=str(content.get("description") or ""),
                )
            except Exception as exc:  # noqa: BLE001
                db.add(JobLog(job_id=job.id, level="error", message=f"YouTube upload error: {exc}"))
                db.commit()
                yt_url = None

            if yt_url:
                row = db.execute(
                    select(Video)
                    .where(Video.project_id == project.id)
                    .order_by(Video.created_at.desc())
                    .limit(1)
                ).scalar_one_or_none()
                if row:
                    row.youtube_url = yt_url
                    row.status = VideoStatus.uploaded
                    db.add(row)
                    db.commit()
                db.add(JobLog(job_id=job.id, level="info", message=f"YouTube: {yt_url}"))
                db.commit()
            else:
                db.add(
                    JobLog(
                        job_id=job.id,
                        level="info",
                        message="YouTube: upload skipped (set youtube_client_id / youtube_client_secret / youtube_refresh_token or check logs).",
                    )
                )
                db.commit()

        if project.status != ProjectStatus.published:
            if yt_url:
                project.status = ProjectStatus.published
            else:
                project.status = ProjectStatus.ready
            db.add(project)
            db.commit()

        parts = [media_summary]
        if yt_url:
            parts.append(f"Published: {yt_url}")
        elif post_publish and mp4_path:
            parts.append("Local MP4 ready (YouTube upload not configured or failed).")
        elif mp4_path:
            parts.append("Local MP4 ready.")

        msg = " | ".join(p for p in parts if p)

        mp4_rel: str | None = None
        if mp4_path is not None:
            try:
                stor = Path(settings.storage_path).expanduser().resolve()
                mp4_rel = str(mp4_path.relative_to(stor)).replace("\\", "/")
            except ValueError:
                mp4_rel = str(mp4_path).replace("\\", "/")

        write_pipeline_debug_bundle(
            project_id=project.id,
            job_id=job.id,
            project_title=project.title,
            brief_json=brief_json,
            script_content=content,
            series_id=project.series_id,
            mp4_relative=mp4_rel,
            skip_local_media=bool(payload.get("skip_local_media")),
        )

        wants_video = (
            not payload.get("skip_local_media")
            and (payload.get("deliverable") or "video").strip().lower() == "video"
        )
        if wants_video and not mp4_path:
            _finalize_job(
                db,
                job_id,
                False,
                "Render finished but no MP4 was produced — check job logs for TTS/image/ffmpeg errors.",
            )
        elif wants_video and _degraded_render_summary(msg):
            _finalize_job(
                db,
                job_id,
                False,
                "Render produced placeholders only (no real images/audio). "
                "Install GPU media packages via Content Studio environment setup, "
                "confirm TTS/image models are downloaded, then retry. "
                f"Detail: {msg[:360]}",
            )
        else:
            _finalize_job(db, job_id, True, msg)
        return job_id
    except JobCancelledError:
        db.rollback()
        try:
            finish_job_cancel(job_id)
        except Exception:  # noqa: BLE001
            pass
        return job_id
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        try:
            job_row = db.get(Job, job_id)
            if job_row:
                p = db.get(VideoProject, job_row.project_id)
                if p and p.status != ProjectStatus.published:
                    p.status = ProjectStatus.failed
                    db.add(p)
                    db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        _finalize_job(db, job_id, False, str(exc))
        return job_id
    finally:
        try:
            from app.services.gpu_release import release_generation_gpu

            release_generation_gpu(reason=f"job_done:{job_id}")
        except Exception:  # noqa: BLE001
            pass
        db.close()


def execute_pipeline_job(job_id: str) -> str:
    """Synchronous entry point (tests or inline execution)."""
    return _run_job(job_id)
