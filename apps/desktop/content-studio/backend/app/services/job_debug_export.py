"""Write human-readable debug dumps next to rendered media (script, prompts, brief)."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


def _storage_project_root(project_id: str) -> Path:
    return Path(settings.storage_path).expanduser().resolve() / project_id


def _job_debug_dir(project_id: str, job_id: str) -> Path:
    return _storage_project_root(project_id) / job_id / "debug"


def _generation_dir(project_id: str, job_id: str) -> Path:
    """Written as soon as the script JSON exists, before TTS / images."""
    return _storage_project_root(project_id) / job_id / "generation"


def _fmt_script_text(content: dict[str, Any]) -> str:
    lines: list[str] = []
    title = str(content.get("title") or "").strip()
    desc = str(content.get("description") or "").strip()
    lines.append(f"TITLE\n{title if title else '(none)'}")
    lines.append("")
    lines.append("DESCRIPTION")
    lines.append(desc if desc else "(none)")
    lines.append("")
    scenes = content.get("scenes")
    if not isinstance(scenes, list):
        lines.append("SCENES: (missing or invalid)")
        return "\n".join(lines)
    for sc in scenes:
        if not isinstance(sc, dict):
            continue
        sn = int(sc.get("scene_number", 0))
        dur = sc.get("duration_seconds", "")
        narr = str(sc.get("narration_text") or "").strip()
        img = str(sc.get("image_prompt") or "").strip()
        trans = str(sc.get("transition") or "").strip()
        overlays = sc.get("text_overlays")
        lines.append(f"--- SCENE {sn:02d} ({dur}s) ---")
        lines.append(f"NARRATION\n{narr if narr else '(none)'}")
        lines.append("")
        lines.append(f"IMAGE PROMPT\n{img if img else '(none)'}")
        lines.append("")
        lines.append(f"TRANSITION: {trans if trans else 'fade'}")
        if overlays:
            lines.append(f"TEXT OVERLAYS: {json.dumps(overlays, ensure_ascii=False)}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _fmt_image_prompts_only(content: dict[str, Any]) -> str:
    lines: list[str] = []
    scenes = content.get("scenes")
    if not isinstance(scenes, list):
        return "(no scenes)\n"
    for sc in scenes:
        if not isinstance(sc, dict):
            continue
        sn = int(sc.get("scene_number", 0))
        img = str(sc.get("image_prompt") or "").strip()
        lines.append(f"Scene {sn:02d}\n{img if img else '(none)'}\n")
    return "\n".join(lines).rstrip() + "\n"


def _fmt_brief_summary(brief_json: dict[str, Any]) -> str:
    keys = [
        "project_id",
        "title",
        "theme",
        "video_type",
        "target_duration_seconds",
        "aspect_ratio",
        "scene_count",
        "planned_total_seconds",
        "include_subtitles",
        "tts_speaker",
        "tts_language",
        "narration_tone",
        "voice_gender",
        "series_title",
        "series_theme",
        "series_topic_dedup_window",
        "prior_projects_dedup_window",
        "script_use_web_research",
    ]
    lines: list[str] = []
    for k in keys:
        if k in brief_json:
            lines.append(f"{k}: {brief_json.get(k)!r}")
    if brief_json.get("series_recent_topics_block"):
        lines.append("")
        lines.append("series_recent_topics_block (excerpt):")
        blk = str(brief_json["series_recent_topics_block"])
        lines.append(blk[:4000] + ("…" if len(blk) > 4000 else ""))
    if brief_json.get("prior_projects_topics_block"):
        lines.append("")
        lines.append("prior_projects_topics_block (excerpt):")
        blk = str(brief_json["prior_projects_topics_block"])
        lines.append(blk[:4000] + ("…" if len(blk) > 4000 else ""))
    lines.append("")
    lines.append("scene_durations_seconds:")
    lines.append(str(brief_json.get("scene_durations_seconds")))
    wr = (brief_json.get("web_research_notes") or "").strip()
    if wr:
        lines.append("")
        lines.append("web_research_notes (excerpt):")
        lines.append(wr[:2500] + ("…" if len(wr) > 2500 else ""))
    return "\n".join(lines) + "\n"


def write_generation_stage_bundle(
    *,
    project_id: str,
    job_id: str,
    brief_json: dict[str, Any],
    script_content: dict[str, Any],
    research_notes: str,
) -> Path | None:
    """
    Persist script artifacts under ``storage/<project_id>/<job_id>/generation/``
    immediately after script generation, **before** TTS and image rendering.
    """
    try:
        gen = _generation_dir(project_id, job_id)
        gen.mkdir(parents=True, exist_ok=True)

        rn = (research_notes or "").strip()
        (gen / "research_notes.txt").write_text(
            rn if rn else "(none — web research disabled, no TAVILY_API_KEY, or search returned no text)\n",
            encoding="utf-8",
        )
        (gen / "video_brief.json").write_text(
            json.dumps(brief_json, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (gen / "video_brief_summary.txt").write_text(_fmt_brief_summary(brief_json), encoding="utf-8")
        (gen / "script.txt").write_text(_fmt_script_text(script_content), encoding="utf-8")
        (gen / "image_prompts.txt").write_text(_fmt_image_prompts_only(script_content), encoding="utf-8")
        (gen / "script_full.json").write_text(
            json.dumps(script_content, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        readme = (
            "These files are produced as soon as the script JSON is ready.\n"
            "Downstream: TTS reads narration from script_full.json / script.txt; "
            "SD3 reads image_prompts.txt / per-scene image_prompt fields.\n"
        )
        (gen / "README.txt").write_text(readme, encoding="utf-8")
        return gen
    except OSError as exc:
        logger.warning("Could not write generation stage bundle: %s", exc)
        return None


def write_pipeline_debug_bundle(
    *,
    project_id: str,
    job_id: str,
    project_title: str,
    brief_json: dict[str, Any],
    script_content: dict[str, Any],
    series_id: str | None = None,
    mp4_relative: str | None = None,
    skip_local_media: bool = False,
) -> Path | None:
    """
    Creates ``storage/<project_id>/<job_id>/debug/*.txt|json`` and
    ``storage/<project_id>/DEBUG_LATEST.txt`` pointing at this run.

    Safe to call on every successful pipeline completion; failures are logged only.
    """
    try:
        dbg = _job_debug_dir(project_id, job_id)
        dbg.mkdir(parents=True, exist_ok=True)

        (dbg / "script.txt").write_text(_fmt_script_text(script_content), encoding="utf-8")
        (dbg / "image_prompts.txt").write_text(_fmt_image_prompts_only(script_content), encoding="utf-8")
        (dbg / "script_full.json").write_text(
            json.dumps(script_content, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (dbg / "video_brief.json").write_text(
            json.dumps(brief_json, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        (dbg / "video_brief_summary.txt").write_text(_fmt_brief_summary(brief_json), encoding="utf-8")

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        meta_lines = [
            f"generated_utc={now}",
            f"project_id={project_id}",
            f"project_title={project_title}",
            f"job_id={job_id}",
        ]
        if series_id:
            meta_lines.append(f"series_id={series_id}")
        meta_lines.append(f"skip_local_media={skip_local_media}")
        if mp4_relative:
            meta_lines.append(f"final_mp4_relative={mp4_relative}")
        meta_lines.append("")
        meta_lines.append(
            "This folder is for debugging: script text, image prompts, and the video brief "
            "snapshot used for this generation run."
        )
        (dbg / "meta.txt").write_text("\n".join(meta_lines) + "\n", encoding="utf-8")

        root = _storage_project_root(project_id)
        root.mkdir(parents=True, exist_ok=True)
        rel_job = f"{project_id}/{job_id}/debug"
        latest = [
            f"generated_utc={now}",
            f"job_id={job_id}",
            f"project_title={project_title}",
            f"debug_folder_relative_to_storage={rel_job}",
            "",
            "Open the `debug` folder inside this job's directory for .txt and .json exports.",
            "Each VideoProject (including series episodes) has its own project_id folder.",
        ]
        (root / "DEBUG_LATEST.txt").write_text("\n".join(latest) + "\n", encoding="utf-8")

        return dbg
    except OSError as exc:
        logger.warning("Could not write pipeline debug bundle: %s", exc)
        return None
