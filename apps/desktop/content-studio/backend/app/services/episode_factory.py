"""Spin up episode VideoProject rows for a series."""

from __future__ import annotations

import copy

from sqlalchemy.orm import Session

from app.models import Series, VideoProject
from app.models.enums import ProjectStatus, VideoType


def create_series_episode_project(db: Session, series: Series) -> VideoProject:
    """Create the next numbered episode linked to ``series``. Consumes queued topics FIFO when present."""
    n = series.next_episode_number
    pat = (series.episode_title_pattern or "{series} — Episode {n}").strip()
    title = pat.replace("{series}", series.title).replace("{n}", str(n))

    topics = list(series.pending_episode_topics or [])
    ep_topic: str | None = topics.pop(0) if topics else None

    vt = series.default_video_type if series.default_video_type is not None else VideoType.youtube_long_16_9
    base_notes = (series.series_notes or "").strip()
    overlay = (
        f"Episode {n} of the series «{series.title}».\n"
        f"Vary hooks and specifics; stay aligned with the series theme below.\n\n{series.theme}"
    )
    content_notes = f"{base_notes}\n\n{overlay}" if base_notes else overlay

    p = VideoProject(
        user_id=series.user_id,
        series_id=series.id,
        title=title,
        theme=series.theme,
        max_duration_seconds=series.default_max_duration_seconds,
        video_type=vt,
        content_notes=content_notes,
        episode_topic=ep_topic,
        include_subtitles=series.default_include_subtitles,
        use_ai_video_title=True,
        tts_speaker=series.default_tts_speaker,
        tts_language=series.default_tts_language,
        narration_tone=series.default_narration_tone,
        tts_voice_style=getattr(series, "default_tts_voice_style", None),
        voice_gender=series.default_voice_gender,
        hf_tts_repo_id=series.default_hf_tts_repo_id,
        hf_image_repo_id=series.default_hf_image_repo_id,
        image_style=getattr(series, "default_image_style", None),
        script_use_web_research=series.default_script_use_web_research,
        no_image_mode=getattr(series, "default_no_image_mode", False),
        status=ProjectStatus.draft,
        is_active=True,
    )
    db.add(p)
    series.next_episode_number = n + 1
    series.pending_episode_topics = topics or None
    db.add(series)
    db.flush()
    return p


def bootstrap_series_episodes(db: Session, series: Series) -> list[VideoProject]:
    """
    Create the first episode row(s) when a series is saved so it appears in the project table.

    One episode is always created. If ``pending_episode_topics`` has queued lines, one episode
    is created per line (each call consumes the next topic FIFO).
    """
    queued = len(series.pending_episode_topics or [])
    count = max(1, queued)
    return [create_series_episode_project(db, series) for _ in range(count)]


def clone_video_project(
    db: Session,
    *,
    source: VideoProject,
    user_id: str,
    title: str,
    link_series: bool = False,
) -> VideoProject:
    """Duplicate generation settings from ``source`` into a new draft project."""
    voice_style = copy.deepcopy(source.tts_voice_style) if source.tts_voice_style else None
    clone = VideoProject(
        user_id=user_id,
        series_id=source.series_id if link_series else None,
        title=title.strip() or "Untitled copy",
        theme=source.theme,
        max_duration_seconds=source.max_duration_seconds,
        video_type=source.video_type,
        content_notes=source.content_notes,
        episode_topic=source.episode_topic,
        tts_speaker=source.tts_speaker,
        tts_language=source.tts_language,
        narration_tone=source.narration_tone,
        tts_voice_style=voice_style,
        voice_gender=source.voice_gender,
        hf_tts_repo_id=source.hf_tts_repo_id,
        hf_image_repo_id=source.hf_image_repo_id,
        image_style=getattr(source, "image_style", None),
        include_subtitles=source.include_subtitles,
        use_ai_video_title=source.use_ai_video_title,
        script_use_web_research=source.script_use_web_research,
        no_image_mode=getattr(source, "no_image_mode", False),
        status=ProjectStatus.draft,
        is_active=True,
        schedule_completed_runs=0,
    )
    db.add(clone)
    db.flush()
    return clone
