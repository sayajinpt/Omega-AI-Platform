"""Call omega-runtime native media pipeline (engine TTS + Ollama images + ffmpeg)."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import JobLog, Video
from app.models.enums import VideoStatus
from app.services.ffmpeg_compose import ffprobe_duration_seconds
from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id
from app.services.native_media_policy import should_use_native_media
from app.services.pipeline_phase import set_pipeline_phase


def _runtime_port() -> str:
    env = (os.environ.get("OMEGA_RUNTIME_PORT") or "").strip()
    if env:
        return env
    state_path = Path.home() / ".omega" / "runtime-state.json"
    if state_path.is_file():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            port = data.get("port")
            if port is not None:
                return str(int(port))
        except (OSError, ValueError, TypeError):
            pass
    return "9877"


def _runtime_base() -> str:
    return f"http://127.0.0.1:{_runtime_port()}"


def _storage_root() -> Path:
    return Path(settings.storage_path).expanduser().resolve()


def build_native_render_body(
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    payload: dict[str, Any],
    tts_speaker: str = "Ryan",
    tts_language: str = "English",
    tts_instruct: str | None = None,
    tts_voice_gender: str = "any",
    hf_tts_repo_id: str | None = None,
    hf_image_repo_id: str | None = None,
    image_style: str | None = None,
    no_image_mode: bool = False,
    no_image_theme: str = "dark",
    deliverable: str = "video",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "job_id": job_id,
        "project_id": project_id,
        "script_content": script_content,
        "brief_json": brief_json,
        "storage_path": str(_storage_root()),
        "hf_tts_repo_id": effective_tts_repo_id(hf_tts_repo_id),
        "hf_image_repo_id": effective_image_repo_id(hf_image_repo_id),
        "no_image_mode": bool(no_image_mode or payload.get("no_image_mode")),
        "no_image_theme": (payload.get("no_image_theme") or no_image_theme or "dark"),
        "skip_sd3": bool(payload.get("skip_sd3")),
        "reuse_images_from_job_id": (payload.get("reuse_images_from_job_id") or "").strip() or None,
        "tts_speaker": tts_speaker,
        "tts_language": tts_language,
        "tts_instruct": tts_instruct,
        "tts_voice_gender": tts_voice_gender,
        "image_style": image_style,
        "include_subtitles": bool(
            brief_json.get("include_subtitles")
            if brief_json.get("include_subtitles") is not None
            else payload.get("include_subtitles")
            if payload.get("include_subtitles") is not None
            else False
        ),
        "deliverable": deliverable,
        "use_native_media": bool(payload.get("use_native_media", True)),
    }
    uoi = payload.get("use_ollama_images")
    if uoi is not None:
        body["use_ollama_images"] = bool(uoi)
    return body


def _post_render(body: dict[str, Any]) -> dict[str, Any]:
    url = f"{_runtime_base()}/v1/content-studio/native/render"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=3600) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if isinstance(payload, dict) and "data" in payload and isinstance(payload["data"], dict):
        return payload["data"]
    return payload if isinstance(payload, dict) else {}


def _apply_native_log_lines(db: Session, job_id: str, result: dict[str, Any]) -> None:
    for entry in result.get("log") or []:
        if isinstance(entry, dict) and entry.get("message"):
            msg = str(entry["message"])
            if msg.startswith("Phase:"):
                if "TTS" in msg:
                    set_pipeline_phase(db, job_id, "tts")
                elif "ffmpeg" in msg:
                    set_pipeline_phase(db, job_id, "ffmpeg")
                elif "image" in msg or "subtitle" in msg.lower():
                    set_pipeline_phase(db, job_id, "images")
            db.add(
                JobLog(
                    job_id=job_id,
                    level=str(entry.get("level") or "info"),
                    message=msg,
                )
            )
    db.commit()


def run_native_partial_render(
    db: Session,
    *,
    job_id: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """Image-only or audio-only via runtime; syncs job logs."""
    set_pipeline_phase(db, job_id, "images" if body.get("deliverable") == "image_only" else "tts")
    db.add(
        JobLog(
            job_id=job_id,
            level="info",
            message="Native media: omega-runtime partial deliverable",
        )
    )
    db.commit()
    try:
        result = _post_render(body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Native render HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "omega-runtime is not reachable for native media — ensure the desktop app started "
            f"the runtime on port {os.environ.get('OMEGA_RUNTIME_PORT', '9877')}"
        ) from exc
    _apply_native_log_lines(db, job_id, result)
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "native render failed")
    return result


def run_native_production_bundle(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    payload: dict[str, Any],
    tts_speaker: str = "Ryan",
    tts_language: str = "English",
    tts_instruct: str | None = None,
    tts_voice_gender: str = "any",
    hf_tts_repo_id: str | None = None,
    hf_image_repo_id: str | None = None,
    image_style: str | None = None,
    no_image_mode: bool = False,
    no_image_theme: str = "dark",
) -> tuple[str, Path]:
    """Native C++ render via omega-runtime; persists Video row like ``run_local_production_bundle``."""
    if not should_use_native_media(payload, hf_tts_repo_id, hf_image_repo_id, no_image_mode):
        raise RuntimeError("native_media_bridge called but native media policy declined")

    set_pipeline_phase(db, job_id, "images")
    db.add(
        JobLog(
            job_id=job_id,
            level="info",
            message="Native media: omega-runtime (engine-first, studio subprocesses, ffmpeg)",
        )
    )
    db.commit()

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
        hf_image_repo_id=hf_image_repo_id,
        image_style=image_style,
        no_image_mode=no_image_mode,
        no_image_theme=no_image_theme,
        deliverable="video",
    )
    try:
        result = _post_render(body)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Native render HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "omega-runtime is not reachable for native media — ensure the desktop app started "
            f"the runtime on port {os.environ.get('OMEGA_RUNTIME_PORT', '9877')}"
        ) from exc

    _apply_native_log_lines(db, job_id, result)

    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "native render failed")

    rel = str(result.get("relativePath") or "").strip()
    mp4_path = _storage_root() / rel if rel else Path(result.get("mp4Path", ""))
    if not mp4_path.is_file():
        raise RuntimeError(f"Native render did not produce MP4 at {mp4_path}")

    set_pipeline_phase(db, job_id, "done")
    dur = int(result.get("durationSeconds") or ffprobe_duration_seconds(mp4_path))
    try:
        rel_path = str(mp4_path.relative_to(_storage_root())).replace("\\", "/")
    except ValueError:
        rel_path = rel or str(mp4_path)

    row = Video(project_id=project_id, file_path=rel_path, status=VideoStatus.ready, duration_seconds=dur)
    db.add(row)
    db.commit()

    summary = str(result.get("summary") or "Native render complete")
    return f"{summary} | Rendered {dur}s MP4 → {rel_path}", mp4_path
