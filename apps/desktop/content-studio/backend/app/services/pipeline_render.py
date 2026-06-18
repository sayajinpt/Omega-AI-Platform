"""Orchestrate images → TTS → ffmpeg (Omega) and persist a ``Video`` row."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import JobLog, Video
from app.models.enums import VideoStatus
from app.services.ffmpeg_compose import assemble_final_mp4, ffprobe_duration_seconds
from app.services.local_pipeline_media import run_local_tts_for_job
from app.services.local_pipeline_sd3 import run_sd3_images_for_job
from app.services.native_media_policy import should_use_native_media
from app.services.pipeline_image_release import release_image_vram_before_tts
from app.services.pipeline_phase import set_pipeline_phase
from app.services.subtitle_frame_renderer import run_subtitle_frames_for_job
from app.services.video_brief import tts_instruct_from_brief_dict


def _log_job_cuda_vram(db: Session, job_id: str, label: str) -> None:
    """Job log line for diffusion speed debugging (worker process VRAM, not desktop telemetry)."""
    try:
        import torch

        if not torch.cuda.is_available():
            db.add(JobLog(job_id=job_id, level="info", message=f"GPU [{label}]: CUDA not available (CPU path)."))
            db.commit()
            return
        free_b, total_b = torch.cuda.mem_get_info(0)
        free_mib = free_b // (1024 * 1024)
        total_mib = total_b // (1024 * 1024)
        lvl = "info" if free_mib >= 8192 else "warning"
        db.add(
            JobLog(
                job_id=job_id,
                level=lvl,
                message=(
                    f"GPU [{label}]: {free_mib} MiB free / {total_mib} MiB total "
                    f"(image diffusion needs ~8+ GiB free; TTS-first ordering left this low in older builds)."
                ),
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.add(JobLog(job_id=job_id, level="warning", message=f"GPU [{label}]: probe failed ({exc})"))
        db.commit()


def _run_legacy_production_bundle(
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
    image_run_kwargs: dict[str, Any] | None = None,
) -> tuple[str, Path]:
    """
    Full local render: narration WAVs, scene PNGs (SD3 or subtitle cards), ``final.mp4``, DB ``Video`` row.

    When ``no_image_mode=True`` SD3 is skipped entirely and the per-scene PNGs are flat subtitle
    cards rendered from each scene's ``narration_text``. ``final.mp4`` is still produced by the
    normal ffmpeg pipeline (still image + TTS WAV per scene → concat).

    Returns ``(summary_line, path_to_mp4)``.
    """
    skip_sd3 = bool(payload.get("skip_sd3"))
    reuse_images_from_job_id = (payload.get("reuse_images_from_job_id") or "").strip() or None
    no_image = bool(no_image_mode or payload.get("no_image_mode"))
    from app.services.script_scenes import sorted_script_scenes

    scenes = sorted_script_scenes(script_content)
    parts: list[str] = []
    effective_instruct = tts_instruct_from_brief_dict(brief_json, override=tts_instruct)

    set_pipeline_phase(db, job_id, "images")

    # Images before TTS: standalone GUI usually diffuses on a fresh GPU load. Running TTS first
    # often leaves ~12–14 GiB in use on a 16 GiB card and makes SDXL steps 10×+ slower.
    if no_image:
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message="No-image mode: skipping SD3; rendering on-screen subtitle frames instead.",
            )
        )
        db.commit()
        parts.append(
            run_subtitle_frames_for_job(
                db,
                job_id=job_id,
                project_id=project_id,
                script_content=script_content,
                brief_json=brief_json,
                theme=no_image_theme,
            )
        )
    else:
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message="Render order: images → TTS → ffmpeg (max VRAM for diffusion before loading TTS).",
            )
        )
        db.commit()
        _log_job_cuda_vram(db, job_id, "before images")
        try:
            from localgen.cuda_sanity import cuda_sanity_report

            db.add(
                JobLog(
                    job_id=job_id,
                    level="info",
                    message=f"CUDA sanity (images): {cuda_sanity_report(light=True)}",
                )
            )
            db.commit()
        except Exception:  # noqa: BLE001
            pass
        parts.append(
            run_sd3_images_for_job(
                db,
                job_id=job_id,
                project_id=project_id,
                script_content=script_content,
                brief_json=brief_json,
                skip_sd3=skip_sd3,
                reuse_images_from_job_id=reuse_images_from_job_id,
                hf_image_repo_id=hf_image_repo_id,
                image_style=image_style,
                image_run_kwargs=image_run_kwargs,
            )
        )
        _log_job_cuda_vram(db, job_id, "after images")
        release_image_vram_before_tts(db, job_id)

    set_pipeline_phase(db, job_id, "tts")
    parts.append(
        run_local_tts_for_job(
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
    )
    _log_job_cuda_vram(db, job_id, "after TTS")

    set_pipeline_phase(db, job_id, "ffmpeg")

    from app.services.local_pipeline_media import _pcm16_wav_peak_abs

    root = Path(settings.storage_path).expanduser().resolve() / project_id / job_id / "audio"
    silent = 0
    for i, sc in enumerate(scenes):
        if not isinstance(sc, dict):
            continue
        sn = int(sc.get("scene_number") or i + 1)
        peak = _pcm16_wav_peak_abs(root / f"scene_{sn:02d}.wav")
        if peak is not None and peak <= 8:
            silent += 1
    if silent >= max(1, len(scenes)):
        db.add(
            JobLog(
                job_id=job_id,
                level="error",
                message=(
                    "TTS produced only silent narration WAVs — MP4 will have little or no audible audio. "
                    "Scene images on disk are kept. Install a TTS model in Settings → Omega tools "
                    "and check job logs for Local TTS warnings."
                ),
            )
        )
        db.commit()

    mp4 = assemble_final_mp4(
        db,
        job_id=job_id,
        project_id=project_id,
        script_content=script_content,
        brief_json=brief_json,
    )
    dur = int(ffprobe_duration_seconds(mp4))
    storage = Path(settings.storage_path).expanduser().resolve()
    try:
        rel = str(mp4.relative_to(storage)).replace("\\", "/")
    except ValueError:
        rel = str(mp4)

    row = Video(project_id=project_id, file_path=rel, status=VideoStatus.ready, duration_seconds=dur)
    db.add(row)
    db.commit()
    parts.append(f"Rendered {dur}s MP4 → {rel}")
    return " | ".join(parts), mp4


def run_local_production_bundle(
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
    image_run_kwargs: dict[str, Any] | None = None,
) -> tuple[str, Path]:
    """
    Full local render via omega-runtime when native media is enabled (default).

    Set ``payload["use_native_media"] = False`` to force the in-process PyTorch path.
    """
    if should_use_native_media(payload, hf_tts_repo_id, hf_image_repo_id, no_image_mode):
        from app.services.native_media_bridge import run_native_production_bundle

        return run_native_production_bundle(
            db,
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
            image_run_kwargs=image_run_kwargs,
        )
    return _run_legacy_production_bundle(
        db,
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
        image_run_kwargs=image_run_kwargs,
    )
