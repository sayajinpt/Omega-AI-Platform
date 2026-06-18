"""Assemble scene PNG + WAV segments into one MP4 via ffmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import JobLog
from app.services.ffmpeg_fonts import resolve_system_font_path
from app.services.ffmpeg_text_overlay import (
    overlay_caption_for_scene,
    video_filter_with_caption,
    write_caption_textfile,
)


def _job_root(project_id: str, job_id: str) -> Path:
    return Path(settings.storage_path).expanduser().resolve() / project_id / job_id


def _dims_from_aspect(aspect: str) -> tuple[int, int]:
    a = (aspect or "16:9").strip()
    if a in ("9:16", "vertical"):
        return 720, 1280
    return 1280, 720


from app.services.script_scenes import sorted_script_scenes as _sorted_script_scenes


def _ffmpeg_concat_line(path: Path) -> str:
    """Absolute path safe for ffmpeg concat demuxer (forward slashes, escaped quotes)."""
    text = path.resolve().as_posix().replace("'", "'\\''")
    return f"file '{text}'"


def ffprobe_duration_seconds(media_path: Path) -> float:
    exe = shutil.which("ffprobe")
    if not exe:
        raise RuntimeError("ffprobe not found on PATH (install FFmpeg).")
    r = subprocess.run(
        [
            exe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(media_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(r.stdout.strip())


def ffprobe_has_audio_stream(media_path: Path) -> bool:
    exe = shutil.which("ffprobe")
    if not exe:
        return True
    r = subprocess.run(
        [
            exe,
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
            str(media_path),
        ],
        capture_output=True,
        text=True,
    )
    return bool((r.stdout or "").strip())


def assemble_final_mp4(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
) -> Path:
    """Concatenate per-scene MP4s (still image + narration) into ``final.mp4``."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found on PATH (install FFmpeg and restart).")

    scenes = _sorted_script_scenes(script_content)
    if not scenes:
        raise RuntimeError("No scenes to render.")

    root = _job_root(project_id, job_id)
    audio_dir = root / "audio"
    images_dir = root / "images"
    segments_dir = root / "segments"
    segments_dir.mkdir(parents=True, exist_ok=True)

    aspect = str(brief_json.get("aspect_ratio") or "16:9")
    tw, th = _dims_from_aspect(aspect)
    font_path = resolve_system_font_path()
    caption_font = segments_dir / "caption_font.ttf"
    if font_path and not caption_font.is_file():
        shutil.copy2(font_path, caption_font)
    fontfile = "caption_font.ttf" if caption_font.is_file() else None
    db.add(
        JobLog(
            job_id=job_id,
            level="info",
            message=(
                f"ffmpeg: assembling {len(scenes)} scene(s) "
                f"({tw}x{th})"
                + (f", caption font: {caption_font.name}" if fontfile else ", captions skipped (no system font)")
            ),
        )
    )
    db.commit()

    segment_paths: list[Path] = []
    for i, sc in enumerate(scenes):
        sn = int(sc.get("scene_number") or i + 1)
        img = images_dir / f"scene_{sn:02d}.png"
        wav = audio_dir / f"scene_{sn:02d}.wav"
        if not img.is_file():
            raise RuntimeError(f"Missing image for scene {sn}: {img}")
        if not wav.is_file():
            raise RuntimeError(f"Missing audio for scene {sn}: {wav}")
        seg = segments_dir / f"scene_{sn:02d}.mp4"
        audio_dur = max(0.1, float(ffprobe_duration_seconds(wav)))
        # Letterbox pad uses dark gray (not black) when aspect differs from still.
        base_vf = (
            f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
            f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:color=0x1a1a1a,format=yuv420p"
        )
        caption = overlay_caption_for_scene(sc)
        caption_fontsize = max(28, min(56, th // 18))
        caption_file = (
            write_caption_textfile(segments_dir, sn, caption, width=tw, fontsize=caption_fontsize)
            if fontfile
            else None
        )
        vf = video_filter_with_caption(
            base_vf,
            caption,
            width=tw,
            height=th,
            fontfile=fontfile,
            textfile=caption_file,
        )
        cmd = [
            ffmpeg,
            "-y",
            "-loop",
            "1",
            "-framerate",
            "25",
            "-i",
            str(img.resolve()),
            "-i",
            str(wav.resolve()),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-t",
            f"{audio_dur:.3f}",
            "-movflags",
            "+faststart",
            str(seg.resolve()),
        ]
        db.add(JobLog(job_id=job_id, level="info", message=f"ffmpeg: encoding scene {sn} segment…"))
        db.commit()
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(segments_dir))
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "ffmpeg scene encode failed").strip()
            tail = err[-2500:] if len(err) > 2500 else err
            db.add(
                JobLog(
                    job_id=job_id,
                    level="error",
                    message=f"ffmpeg scene {sn} failed: {tail}",
                )
            )
            db.commit()
            raise RuntimeError(
                f"ffmpeg scene {sn} encode failed"
                + (f" (Fontconfig/drawtext — rebuild Omega for caption font fix). {tail[-400:]}" if "Fontconfig" in err or "drawtext" in err else f". {tail[-400:]}")
            )
        if not ffprobe_has_audio_stream(seg):
            db.add(
                JobLog(
                    job_id=job_id,
                    level="error",
                    message=(
                        f"ffmpeg: scene {sn} segment has no audio stream — "
                        f"check TTS output at {wav.name} (silent placeholder or bad WAV)."
                    ),
                )
            )
            db.commit()
        segment_paths.append(seg)

    final = root / "final.mp4"
    if len(segment_paths) == 1:
        shutil.copy2(segment_paths[0], final)
    else:
        concat_list = segments_dir / "concat.txt"
        concat_list.write_text(
            "\n".join(_ffmpeg_concat_line(p) for p in segment_paths),
            encoding="utf-8",
        )
        # Re-encode on concat — stream copy often drops AAC audio on Windows players.
        cmd = [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(final),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "ffmpeg concat failed").strip()
            raise RuntimeError(err[-2000:] if len(err) > 2000 else err)

    if not ffprobe_has_audio_stream(final):
        db.add(
            JobLog(
                job_id=job_id,
                level="error",
                message=(
                    "ffmpeg: final MP4 has no audio track — narration WAVs may be silent placeholders. "
                    "Check job logs for Local TTS warnings and confirm a TTS model is installed in Settings."
                ),
            )
        )
        db.commit()
    else:
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message="ffmpeg: final MP4 includes an audio track.",
            )
        )
        db.commit()

    db.add(JobLog(job_id=job_id, level="info", message=f"ffmpeg: final MP4 → {final}"))
    db.commit()
    return final
