"""
On-demand Content Studio operations for omega-runtime (no uvicorn).

Usage: python -m app.cli.cs_invoke <command> [--request-file PATH]

Reads JSON request from --request-file or stdin; prints JSON to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import or_, select

from app.config import settings
from app.database import SessionLocal
from app.models import Job, Schedule, Series, SocialAccount, SocialPost, User, VideoProject
from app.models.enums import JobStatus, ProjectStatus, SocialPlatform, SocialPostStatus, VideoType
from app.schemas import (
    AgentJobStatus,
    AgentPipelineMode,
    AgentProjectSummary,
    AgentRunCreate,
    AgentRunCreated,
    ScheduleCreate,
    ScheduleRead,
    SeriesCreate,
    SeriesRead,
)
from app.services.agent_content import build_agent_job_status, latest_script_for_project
from app.services.duration_policy import normalize_duration_seconds
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.job_cancel import mark_job_cancelled, request_job_cancel
from app.services.local_user import get_or_create_local_user_db
from app.services.pipeline_jobs import enqueue_pipeline_job
from app.services.runtime_credentials import apply_credentials, credentials_status, patch_settings_object
from app.services.script_llm import compose_script_llm_prompts
from app.services.tts_language import normalize_tts_language
from app.services.video_brief import build_ephemeral_brief
from app.services.video_format_resolver import normalize_image_style, resolve_video_type
from app.services.social.publish import publish_post, resolve_media_for_project
from app.services.social.registry import list_platforms
from app.services.worker_registry import (
  job_has_live_worker,
  prune_stale_worker_pids,
  reconcile_orphaned_pipeline_jobs,
)
from app.services.youtube_oauth import exchange_code_for_refresh_token, youtube_auth_url
from app.workers.queue import any_pipeline_worker_running, force_mark_worker_idle, kill_pipeline_job


class CliError(Exception):
  def __init__(self, status: int, detail: str) -> None:
    self.status = status
    super().__init__(detail)


_RESPONSE_PATH: Path | None = None


def _write_response(payload: dict[str, Any]) -> None:
  text = json.dumps(payload, ensure_ascii=False, default=str)
  if _RESPONSE_PATH is not None:
    _RESPONSE_PATH.write_text(text, encoding="utf-8")
    return
  sys.stdout.buffer.write(text.encode("utf-8"))
  sys.stdout.buffer.write(b"\n")
  sys.stdout.buffer.flush()


def _emit_ok(data: Any) -> None:
  _write_response({"ok": True, "data": data})


def _emit_empty() -> None:
  _write_response({"ok": True, "data": None})


def _emit_err(status: int, detail: str) -> None:
  _write_response({"ok": False, "status": status, "detail": detail})


def _local_user(db) -> User:
  return get_or_create_local_user_db(db)


def _active_pipeline_busy(db) -> bool:
  prune_stale_worker_pids()
  reconcile_orphaned_pipeline_jobs(db)
  if any_pipeline_worker_running():
    return True
  rows = db.execute(
    select(Job.id).where(Job.status.in_((JobStatus.queued, JobStatus.running)))
  ).scalars().all()
  for jid in rows:
    if job_has_live_worker(str(jid)):
      return True
  return False


def cmd_pipeline_idle(_req: dict[str, Any]) -> None:
  db = SessionLocal()
  try:
    _emit_ok({"idle": not _active_pipeline_busy(db)})
  finally:
    db.close()


def _resolve_pipeline_flags(mode: str) -> tuple[bool, bool, bool, str | None]:
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
  raise CliError(400, "pipeline_mode must be script_only, local_media, full_publish, image_only, or audio_only")


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
  try:
    dur = normalize_duration_seconds(body.max_duration_seconds)
  except ValueError as exc:
    raise CliError(400, str(exc)) from exc
  fmt_hint = (body.video_format or "").strip() or None
  vt = body.video_type or resolve_video_type(
    theme=theme,
    video_format=fmt_hint,
    image_style=body.image_style,
    max_duration_seconds=dur,
  )
  img_style = normalize_image_style(body.image_style, video_type=vt)
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
    tts_language=normalize_tts_language((body.tts_language or "English").strip())[:64],
    narration_tone=(body.narration_tone or "").strip() or None,
    voice_gender=(body.voice_gender or "any").strip()[:32],
    image_style=img_style,
    hf_tts_repo_id=effective_tts_repo_id(None),
    hf_image_repo_id=effective_image_repo_id(None),
    status=ProjectStatus.draft,
    is_active=True,
  )


def _get_owned_job(db, user: User, job_id: str) -> Job:
  job = db.get(Job, job_id)
  if not job:
    raise CliError(404, "Job not found")
  project = db.get(VideoProject, job.project_id)
  if not project or project.user_id != user.id:
    raise CliError(404, "Job not found")
  return job


def _get_owned_project(db, user: User, project_id: str) -> VideoProject:
  project = db.get(VideoProject, project_id)
  if not project or project.user_id != user.id:
    raise CliError(404, "Project not found")
  return project


def cmd_list_projects(req: dict[str, Any]) -> None:
  limit = int(req.get("limit") or 50)
  limit = max(1, min(limit, 200))
  db = SessionLocal()
  try:
    user = _local_user(db)
    rows = (
      db.execute(
        select(VideoProject)
        .where(VideoProject.user_id == user.id)
        .order_by(VideoProject.updated_at.desc())
        .limit(limit)
      )
      .scalars()
      .all()
    )
    out = [
      AgentProjectSummary(
        id=p.id,
        title=(p.title or "Untitled")[:255],
        theme=(p.theme or "")[:500],
        status=p.status.value if hasattr(p.status, "value") else str(p.status),
        updated_at=p.updated_at,
      ).model_dump(mode="json")
      for p in rows
    ]
    _emit_ok(out)
  finally:
    db.close()


def cmd_create_run(req: dict[str, Any]) -> None:
  os.environ.setdefault("OMEGA_CS_DEFER_WORKER_SPAWN", "1")
  db = SessionLocal()
  try:
    user = _local_user(db)
    prune_stale_worker_pids()
    reconcile_orphaned_pipeline_jobs(db)
    if _active_pipeline_busy(db):
      raise CliError(
        409,
        "A Content Studio pipeline worker is still running. "
        "Stop the current job or wait until it finishes before starting another.",
      )

    body = AgentRunCreate.model_validate(req)
    post_publish, skip_media, skip_llm, deliverable = _resolve_pipeline_flags(body.pipeline_mode)
    script_mode = (body.script_mode or settings.content_script_mode or "content_studio").strip().lower()
    script_content = body.script_content if isinstance(body.script_content, dict) else None
    if script_mode == "agent_orchestrated" and not script_content:
      raise CliError(
        400,
        "agent_orchestrated requires script_content (Omega agent prepares script, pipeline runs TTS/render).",
      )
    if script_content:
      skip_llm = True

    if body.project_id:
      project = _get_owned_project(db, user, body.project_id)
      if (body.voice_gender or "").strip():
        project.voice_gender = body.voice_gender.strip()[:32]
      if (body.narration_tone or "").strip():
        project.narration_tone = body.narration_tone.strip() or None
      if (body.tts_language or "").strip():
        project.tts_language = normalize_tts_language(body.tts_language.strip())[:64]
      if (body.tts_speaker or "").strip():
        project.tts_speaker = body.tts_speaker.strip()[:64]
      db.add(project)
      db.commit()
      db.refresh(project)
    else:
      project = _create_project_from_agent(body, user)
      fmt_hint = (body.video_format or "").strip() or None
      if not body.video_type and not fmt_hint:
        if (
          body.max_duration_seconds is not None
          and int(body.max_duration_seconds) <= 120
          and project.video_type == VideoType.youtube_long_16_9
        ):
          project.video_type = VideoType.youtube_shorts_vertical
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
    from app.services.omega_debug import emit_debug

    emit_debug(
      f"create-run queued job={job.id}",
      data={
        "job_id": str(job.id),
        "project_id": str(project.id),
        "use_native_media": body.use_native_media,
        "script_mode": script_mode,
      },
    )

    prefix = settings.api_prefix.rstrip("/")
    created = AgentRunCreated(
      job_id=job.id,
      project_id=project.id,
      status=job.status.value if hasattr(job.status, "value") else str(job.status),
      poll_url=f"{prefix}/agent/v1/runs/{job.id}",
      content_url=f"{prefix}/agent/v1/runs/{job.id}/content",
    )
    _emit_ok(created.model_dump(mode="json"))
  finally:
    db.close()


def cmd_get_run(req: dict[str, Any]) -> None:
  job_id = str(req.get("job_id") or "").strip()
  if not job_id:
    raise CliError(400, "job_id required")
  log_limit = int(req.get("log_limit") or 40)
  log_limit = max(0, min(log_limit, 200))
  db = SessionLocal()
  try:
    prune_stale_worker_pids()
    reconcile_orphaned_pipeline_jobs(db)
    user = _local_user(db)
    job = _get_owned_job(db, user, job_id)
    data = build_agent_job_status(db, job, log_limit=log_limit)
    _emit_ok(AgentJobStatus(**data).model_dump(mode="json"))
  finally:
    db.close()


def cmd_cancel_run(req: dict[str, Any]) -> None:
  job_id = str(req.get("job_id") or "").strip()
  if not job_id:
    raise CliError(400, "job_id required")
  db = SessionLocal()
  try:
    user = _local_user(db)
    job = _get_owned_job(db, user, job_id)
    if job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
      data = build_agent_job_status(db, job, log_limit=20)
      _emit_ok(AgentJobStatus(**data).model_dump(mode="json"))
      return
    request_job_cancel(job_id)
    killed = kill_pipeline_job(job_id)
    try:
      from app.services.pipeline_job_pipes import dispose_job_image_pipe

      dispose_job_image_pipe(job_id)
    except Exception:  # noqa: BLE001
      pass
    try:
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
      from app.models import JobLog

      db.add(
        JobLog(
          job_id=job_id,
          level="warning",
          message="Pipeline worker process terminated (hard stop).",
        )
      )
      db.commit()
  finally:
    db.close()
  db = SessionLocal()
  try:
    user = _local_user(db)
    job = _get_owned_job(db, user, job_id)
    data = build_agent_job_status(db, job, log_limit=20)
    _emit_ok(AgentJobStatus(**data).model_dump(mode="json"))
  finally:
    db.close()


def cmd_gpu_unload(req: dict[str, Any]) -> None:
  reason = str(req.get("reason") or "omega_request")
  force = bool(req.get("force")) or reason == "user_stop" or reason.startswith("cancel:")
  if any_pipeline_worker_running() and not force:
    _emit_ok(
      {
        "ok": False,
        "skipped": True,
        "detail": (
          "Pipeline worker still running — skipped GPU unload so diffusion is not torn down mid-step."
        ),
      }
    )
    return
  from app.services.gpu_release import release_generation_gpu

  detail = release_generation_gpu(reason=reason)
  _emit_ok({"ok": True, "detail": detail})


def cmd_put_credentials(req: dict[str, Any]) -> None:
  applied = apply_credentials(req)
  patch_settings_object(settings)
  _emit_ok({"applied": list(applied.keys()), "platforms": credentials_status(settings)})


def cmd_credentials_status(_req: dict[str, Any]) -> None:
  patch_settings_object(settings)
  _emit_ok({"platforms": credentials_status(settings)})


def cmd_youtube_oauth_url(req: dict[str, Any]) -> None:
  redirect_uri = (req.get("redirect_uri") or "").strip() or None
  try:
    url = youtube_auth_url(redirect_uri=redirect_uri)
  except ValueError as exc:
    raise CliError(400, str(exc)) from exc
  _emit_ok({"url": url, "redirect_uri": redirect_uri or settings.youtube_oauth_redirect_uri})


def cmd_youtube_oauth_exchange(req: dict[str, Any]) -> None:
  code = str(req.get("code") or "").strip()
  if not code:
    raise CliError(400, "code required")
  redirect_uri = (req.get("redirect_uri") or "").strip() or None
  try:
    refresh = exchange_code_for_refresh_token(code, redirect_uri=redirect_uri)
  except ValueError as exc:
    raise CliError(400, str(exc)) from exc
  apply_credentials({"YOUTUBE_REFRESH_TOKEN": refresh})
  patch_settings_object(settings)
  _emit_ok({"refresh_token": refresh, "connected": True})


def cmd_list_schedules(_req: dict[str, Any]) -> None:
  db = SessionLocal()
  try:
    user = _local_user(db)
    q = (
      select(Schedule)
      .outerjoin(VideoProject, Schedule.project_id == VideoProject.id)
      .outerjoin(Series, Schedule.series_id == Series.id)
      .where(or_(VideoProject.user_id == user.id, Series.user_id == user.id))
    )
    rows = list(db.scalars(q).unique().all())
    _emit_ok([ScheduleRead.model_validate(r).model_dump(mode="json") for r in rows])
  finally:
    db.close()


def cmd_create_schedule(req: dict[str, Any]) -> None:
  body = ScheduleCreate.model_validate(req)
  db = SessionLocal()
  try:
    user = _local_user(db)
    if body.series_id:
      series = db.get(Series, body.series_id)
      if not series or series.user_id != user.id:
        raise CliError(400, "Invalid series_id")
    else:
      project = db.get(VideoProject, body.project_id or "")
      if not project or project.user_id != user.id:
        raise CliError(400, "Invalid project_id")
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
    _emit_ok(ScheduleRead.model_validate(schedule).model_dump(mode="json"))
  finally:
    db.close()


def cmd_delete_schedule(req: dict[str, Any]) -> None:
  schedule_id = str(req.get("schedule_id") or "").strip()
  if not schedule_id:
    raise CliError(400, "schedule_id required")
  db = SessionLocal()
  try:
    user = _local_user(db)
    schedule = db.get(Schedule, schedule_id)
    if not schedule:
      raise CliError(404, "Schedule not found")
    if schedule.project_id:
      _get_owned_project(db, user, schedule.project_id)
    elif schedule.series_id:
      series = db.get(Series, schedule.series_id)
      if not series or series.user_id != user.id:
        raise CliError(404, "Schedule not found")
    db.delete(schedule)
    db.commit()
    _emit_empty()
  finally:
    db.close()


def cmd_list_series(_req: dict[str, Any]) -> None:
  db = SessionLocal()
  try:
    user = _local_user(db)
    rows = db.execute(
      select(Series).where(Series.user_id == user.id).order_by(Series.updated_at.desc())
    ).scalars().all()
    _emit_ok([SeriesRead.model_validate(r).model_dump(mode="json") for r in rows])
  finally:
    db.close()


def cmd_create_series(req: dict[str, Any]) -> None:
  body = SeriesCreate.model_validate(req)
  db = SessionLocal()
  try:
    user = _local_user(db)
    s = Series(
      user_id=user.id,
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
    _emit_ok(SeriesRead.model_validate(s).model_dump(mode="json"))
  finally:
    db.close()


def cmd_delete_series(req: dict[str, Any]) -> None:
  series_id = str(req.get("series_id") or "").strip()
  if not series_id:
    raise CliError(400, "series_id required")
  db = SessionLocal()
  try:
    user = _local_user(db)
    series = db.get(Series, series_id)
    if not series or series.user_id != user.id:
      raise CliError(404, "Series not found")
    db.delete(series)
    db.commit()
    _emit_empty()
  finally:
    db.close()


def _social_row_account(row: SocialAccount) -> dict[str, Any]:
  plat = row.platform.value if hasattr(row.platform, "value") else str(row.platform)
  return {
    "id": row.id,
    "platform": plat,
    "account_label": row.account_label,
    "external_id": row.external_id,
    "is_active": bool(row.is_active),
  }


def _social_row_post(row: SocialPost) -> dict[str, Any]:
  plat = row.platform.value if hasattr(row.platform, "value") else str(row.platform)
  st = row.status.value if hasattr(row.status, "value") else str(row.status)
  return {
    "id": row.id,
    "platform": plat,
    "title": row.title,
    "caption": row.caption,
    "project_id": row.project_id,
    "status": st,
    "published_url": row.published_url,
    "error_message": row.error_message,
    "scheduled_at": row.scheduled_at,
  }


def cmd_probe_capabilities(req: dict[str, Any]) -> None:
  from app.services.generation_capabilities import probe_generation_capabilities

  modality = str(req.get("modality") or "").strip().lower()
  repo_id = str(req.get("repo_id") or req.get("repoId") or "").strip()
  if modality not in ("tts", "image", "video"):
    raise CliError(400, "modality must be tts, image, or video")
  if not repo_id:
    raise CliError(400, "repo_id required")
  _emit_ok(probe_generation_capabilities(modality, repo_id))  # type: ignore[arg-type]


def cmd_generation_catalog(_req: dict[str, Any]) -> None:
  from localgen.installed_models import list_models_for_ui
  from localgen.paths import get_models_root
  from localgen.registry import (
    DEFAULT_IMAGE_REPO_ID,
    DEFAULT_TTS_REPO_ID,
    studio_suggested_image_catalog,
    studio_suggested_tts_catalog,
  )

  def _entries(cat: dict, kind: str) -> list[dict[str, str | bool]]:
    from localgen.installed_models import _dir_nonempty, repo_snapshot_dir

    out: list[dict[str, str | bool]] = []
    root = get_models_root()
    for key, meta in cat.items():
      repo_id = str(meta.get("id") or key)
      on_disk = _dir_nonempty(repo_snapshot_dir(root, kind, repo_id))  # type: ignore[arg-type]
      out.append(
        {
          "key": key,
          "repo_id": repo_id,
          "description": str(meta.get("description") or ""),
          "size": str(meta.get("size") or ""),
          "on_disk": on_disk,
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

  suggested_tts = _entries(studio_suggested_tts_catalog(), "tts")
  suggested_image = _entries(studio_suggested_image_catalog(), "image")

  _emit_ok(
    {
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
        "tts": DEFAULT_TTS_REPO_ID,
        "image": DEFAULT_IMAGE_REPO_ID,
        "script_mode": "content_studio",
        "omega_model_id": "",
      },
    }
  )


def cmd_social_platforms(_req: dict[str, Any]) -> None:
  _emit_ok(list_platforms())


def cmd_social_accounts(req: dict[str, Any]) -> None:
  db = SessionLocal()
  try:
    user = _local_user(db)
    rows = db.scalars(
      select(SocialAccount)
      .where(SocialAccount.user_id == user.id)
      .order_by(SocialAccount.created_at.desc())
    ).all()
    _emit_ok([_social_row_account(r) for r in rows])
  finally:
    db.close()


def cmd_social_posts(req: dict[str, Any]) -> None:
  limit = min(int(req.get("limit") or 50), 200)
  db = SessionLocal()
  try:
    user = _local_user(db)
    rows = db.scalars(
      select(SocialPost)
      .where(SocialPost.user_id == user.id)
      .order_by(SocialPost.updated_at.desc())
      .limit(limit)
    ).all()
    _emit_ok([_social_row_post(r) for r in rows])
  finally:
    db.close()


def cmd_social_publish(req: dict[str, Any]) -> None:
  db = SessionLocal()
  try:
    user = _local_user(db)
    try:
      plat = SocialPlatform(str(req.get("platform") or "").strip().lower())
    except ValueError as exc:
      raise CliError(400, f"Unsupported platform: {req.get('platform')}") from exc
    project_id = (req.get("project_id") or "").strip() or None
    media = (req.get("media_path") or "").strip() or None
    if project_id and not media:
      media = resolve_media_for_project(db, project_id)
      proj = db.get(VideoProject, project_id)
      if not proj or proj.user_id != user.id:
        raise CliError(404, "Project not found")
    account = None
    account_id = (req.get("account_id") or "").strip() or None
    if account_id:
      account = db.get(SocialAccount, account_id)
      if not account or account.user_id != user.id:
        raise CliError(404, "Account not found")
    scheduled_at = req.get("scheduled_at")
    if isinstance(scheduled_at, str) and scheduled_at:
      scheduled_at = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
    post = SocialPost(
      user_id=user.id,
      project_id=project_id,
      account_id=account_id,
      platform=plat,
      title=str(req.get("title") or "")[:512],
      caption=req.get("caption"),
      media_path=media,
      status=SocialPostStatus.scheduled if scheduled_at else SocialPostStatus.draft,
      scheduled_at=scheduled_at,
    )
    db.add(post)
    db.commit()
    db.refresh(post)
    if bool(req.get("publish_now")):
      publish_post(db, post, account=account)
    _emit_ok(_social_row_post(post))
  finally:
    db.close()


def cmd_build_script_prompt(req: dict[str, Any]) -> None:
  theme = str(req.get("theme") or req.get("topic") or "").strip()
  title = str(req.get("title") or theme or "Content Studio run").strip()
  fmt_hint = str(req.get("video_format") or req.get("video_type") or "").strip() or None
  image_style_raw = str(req.get("image_style") or "").strip() or None
  raw_dur = req.get("max_duration_seconds")
  try:
    if raw_dur is not None and str(raw_dur).strip():
      dur = normalize_duration_seconds(int(raw_dur))
    else:
      fmt_lower = (fmt_hint or "").lower()
      if "short" in fmt_lower:
        dur = 30
      else:
        dur = normalize_duration_seconds(None)
  except (TypeError, ValueError) as exc:
    raise CliError(400, str(exc)) from exc

  vt = resolve_video_type(
    theme=theme,
    video_format=fmt_hint,
    image_style=image_style_raw,
    max_duration_seconds=dur,
  )
  img_style = normalize_image_style(image_style_raw, video_type=vt)
  notes = str(req.get("content_notes") or "").strip() or None
  if (req.get("subtitle_language") or "").strip():
    sub = str(req["subtitle_language"]).strip()
    notes = (notes + "\n" if notes else "") + f"Subtitle language: {sub}"

  brief = build_ephemeral_brief(
    theme=theme or title,
    title=title,
    video_type=vt,
    max_duration_seconds=dur,
    content_notes=notes,
    include_subtitles=bool(req.get("include_subtitles")),
    narration_tone=str(req.get("narration_tone") or "").strip() or None,
    tts_language=normalize_tts_language(str(req.get("tts_language") or "English"))[:64],
    tts_speaker=str(req.get("tts_speaker") or "Ryan").strip()[:64],
    voice_gender=str(req.get("voice_gender") or "any").strip()[:32],
    no_image_mode=bool(req.get("no_image_mode")),
  )
  brief_json = json.loads(brief.model_dump_json())
  system_prompt, user_prompt = compose_script_llm_prompts(brief, compact=True)
  _emit_ok(
    {
      "system_prompt": system_prompt,
      "user_prompt": user_prompt,
      "brief": brief_json,
      "video_type": vt.value,
      "image_style": img_style,
      "scene_count": brief.scene_count,
      "aspect_ratio": brief.aspect_ratio,
    }
  )


def cmd_validate_agent_script(req: dict[str, Any]) -> None:
  from app.services.cursor_script_merge import merge_validated_script

  script = req.get("script")
  brief_json = req.get("brief")
  if not isinstance(script, dict):
    raise CliError(400, "script object required")
  if not isinstance(brief_json, dict):
    raise CliError(400, "brief object required")

  theme = str(brief_json.get("theme") or script.get("title") or "Content Studio run")
  title = str(script.get("title") or brief_json.get("title") or theme)
  stub = VideoProject(
    user_id="ephemeral",
    title=title[:255],
    theme=theme[:2000],
    max_duration_seconds=int(brief_json.get("target_duration_seconds") or 60),
    video_type=VideoType(str(brief_json.get("video_type") or VideoType.custom.value)),
    include_subtitles=bool(brief_json.get("include_subtitles")),
    image_style=normalize_image_style(
      str(req.get("image_style") or ""),
      video_type=VideoType(str(brief_json.get("video_type") or VideoType.custom.value)),
    ),
    status=ProjectStatus.draft,
    is_active=True,
  )
  merged = merge_validated_script(stub, brief_json, script, orchestrator="omega_agent")
  _emit_ok({"script": merged, "scene_count": len(merged.get("scenes") or [])})


_COMMANDS: dict[str, Any] = {
  "list-projects": cmd_list_projects,
  "create-run": cmd_create_run,
  "get-run": cmd_get_run,
  "pipeline-idle": cmd_pipeline_idle,
  "cancel-run": cmd_cancel_run,
  "gpu-unload": cmd_gpu_unload,
  "put-credentials": cmd_put_credentials,
  "credentials-status": cmd_credentials_status,
  "youtube-oauth-url": cmd_youtube_oauth_url,
  "youtube-oauth-exchange": cmd_youtube_oauth_exchange,
  "list-schedules": cmd_list_schedules,
  "create-schedule": cmd_create_schedule,
  "delete-schedule": cmd_delete_schedule,
  "list-series": cmd_list_series,
  "create-series": cmd_create_series,
  "delete-series": cmd_delete_series,
  "generation-catalog": cmd_generation_catalog,
  "probe-capabilities": cmd_probe_capabilities,
  "social-platforms": cmd_social_platforms,
  "social-accounts": cmd_social_accounts,
  "social-posts": cmd_social_posts,
  "social-publish": cmd_social_publish,
  "build-script-prompt": cmd_build_script_prompt,
  "validate-agent-script": cmd_validate_agent_script,
}


def main() -> int:
  global _RESPONSE_PATH
  parser = argparse.ArgumentParser(description="Content Studio on-demand CLI (omega-runtime)")
  parser.add_argument("command", choices=sorted(_COMMANDS.keys()))
  parser.add_argument("--request-file", default="", help="JSON request path (preferred on Windows)")
  parser.add_argument("--response-file", default="", help="UTF-8 JSON response path (required by omega-runtime)")
  args = parser.parse_args()

  if args.response_file.strip():
    _RESPONSE_PATH = Path(args.response_file)

  try:
    if args.request_file.strip():
      raw = Path(args.request_file).read_text(encoding="utf-8")
    else:
      raw = sys.stdin.read()
    req = json.loads(raw) if raw.strip() else {}
  except json.JSONDecodeError as exc:
    _emit_err(400, f"invalid JSON: {exc}")
    return 1

  from app.services.omega_debug import emit_debug
  from app.services.runtime_credentials import bootstrap_settings_from_env

  os.environ.setdefault("OMEGA_CS_INVOKE", "1")
  bootstrap_settings_from_env()

  emit_debug(f"cs_invoke {args.command} start", data={"command": args.command})

  try:
    _COMMANDS[args.command](req)
    emit_debug(f"cs_invoke {args.command} ok")
    return 0
  except CliError as exc:
    emit_debug(f"cs_invoke {args.command} error: {exc}", level="error",
               data={"status": exc.status})
    _emit_err(exc.status, str(exc))
    return 1
  except Exception as exc:  # noqa: BLE001
    tb = traceback.format_exc()
    emit_debug(f"cs_invoke {args.command} exception: {exc}", level="error",
               data={"traceback": tb[-800:]})
    _emit_err(500, f"{exc}\n{tb[-1500:]}")
    return 1


if __name__ == "__main__":
  raise SystemExit(main())
