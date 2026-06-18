"""
Run one Content Studio media phase (images or TTS) for omega-runtime native orchestration.

Reads JSON request from stdin or --request-file; writes JSON result to stdout or --response-file.
Progress and diffusers logs must not go to stdout — runtime reads the response file only.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

from app.database import SessionLocal
from app.models import Job, JobLog
from app.services.runtime_credentials import bootstrap_settings_from_env


def _log(db, job_id: str, level: str, message: str) -> None:
    if not job_id:
        return
    db.add(JobLog(job_id=job_id, level=level, message=message))
    db.commit()


def _emit_result(payload: dict[str, Any], *, response_file: str) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    path = (response_file or "").strip()
    if path:
        Path(path).write_text(text, encoding="utf-8")
    else:
        print(text)


def _run_images(db, req: dict[str, Any]) -> str:
    from app.services.local_pipeline_sd3 import run_sd3_images_for_job

    return run_sd3_images_for_job(
        db,
        job_id=str(req["job_id"]),
        project_id=str(req["project_id"]),
        script_content=req.get("script_content") or {},
        brief_json=req.get("brief_json") or {},
        skip_sd3=bool(req.get("skip_sd3")),
        reuse_images_from_job_id=(req.get("reuse_images_from_job_id") or "").strip() or None,
        hf_image_repo_id=(req.get("hf_image_repo_id") or "").strip() or None,
        image_style=(req.get("image_style") or "").strip() or None,
    )


def _run_subtitle_frames(db, req: dict[str, Any]) -> str:
    from app.services.subtitle_frame_renderer import run_subtitle_frames_for_job

    return run_subtitle_frames_for_job(
        db,
        job_id=str(req["job_id"]),
        project_id=str(req["project_id"]),
        script_content=req.get("script_content") or {},
        brief_json=req.get("brief_json") or {},
        theme=str(req.get("no_image_theme") or "dark"),
    )


def _run_tts(db, req: dict[str, Any]) -> str:
    from app.services.local_pipeline_media import run_local_tts_for_job
    from app.services.video_brief import tts_instruct_from_brief_dict

    brief = req.get("brief_json") or {}
    instruct = req.get("tts_instruct")
    effective_instruct = tts_instruct_from_brief_dict(brief, override=instruct)
    return run_local_tts_for_job(
        db,
        job_id=str(req["job_id"]),
        project_id=str(req["project_id"]),
        script_content=req.get("script_content") or {},
        speaker=str(req.get("tts_speaker") or "Ryan"),
        language=str(req.get("tts_language") or "English"),
        instruct=effective_instruct,
        hf_tts_repo_id=(req.get("hf_tts_repo_id") or "").strip() or None,
        voice_gender=str(req.get("tts_voice_gender") or "any"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Content Studio native media phase (runtime subprocess)")
    parser.add_argument("--request-file", default="", help="JSON request path (preferred on Windows)")
    parser.add_argument("--response-file", default="", help="JSON response path (required for long GPU phases)")
    args = parser.parse_args()

    try:
        if args.request_file.strip():
            raw = Path(args.request_file).read_text(encoding="utf-8")
        else:
            raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        _emit_result({"ok": False, "error": f"invalid JSON: {exc}"}, response_file=args.response_file)
        return 1

    phase = str(req.get("phase") or "").strip().lower()
    chat_phases = ("chat_image", "chat_tts", "chat_video")
    job_phases = ("images", "tts", "subtitle_frames")
    if phase not in job_phases + chat_phases:
        _emit_result(
            {
                "ok": False,
                "error": "phase must be images, tts, subtitle_frames, chat_image, chat_tts, or chat_video",
            },
            response_file=args.response_file,
        )
        return 1

    bootstrap_settings_from_env()

    if phase in chat_phases:
        try:
            if phase == "chat_image":
                from app.services.chat_media_generate import run_chat_image

                payload = run_chat_image(req)
            elif phase == "chat_video":
                from app.services.chat_media_generate import run_chat_video

                payload = run_chat_video(req)
            else:
                from app.services.chat_media_generate import run_chat_tts

                payload = run_chat_tts(req)
            _emit_result(
                {
                    "ok": True,
                    "phase": phase,
                    "summary": payload.get("summary", ""),
                    "out_path": payload.get("out_path", ""),
                    "repo_id": payload.get("repo_id", ""),
                },
                response_file=args.response_file,
            )
            return 0
        except Exception as exc:  # noqa: BLE001
            tb = traceback.format_exc()
            _emit_result(
                {"ok": False, "error": str(exc), "traceback": tb[-2000:]},
                response_file=args.response_file,
            )
            return 1

    job_id = str(req.get("job_id") or "")
    project_id = str(req.get("project_id") or "")
    if not job_id or not project_id:
        _emit_result({"ok": False, "error": "job_id and project_id required"}, response_file=args.response_file)
        return 1

    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job is None:
            _emit_result({"ok": False, "error": f"job not found: {job_id}"}, response_file=args.response_file)
            return 1

        _log(db, job_id, "info", f"Native media phase «{phase}» (runtime subprocess)")

        if phase == "images":
            summary = _run_images(db, req)
        elif phase == "tts":
            summary = _run_tts(db, req)
        else:
            summary = _run_subtitle_frames(db, req)

        _emit_result({"ok": True, "phase": phase, "summary": summary}, response_file=args.response_file)
        return 0
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        if job_id:
            _log(db, job_id, "error", f"Native media phase {phase} failed: {exc}")
        _emit_result({"ok": False, "error": str(exc), "traceback": tb[-2000:]}, response_file=args.response_file)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
