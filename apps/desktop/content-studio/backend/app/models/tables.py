from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, Float, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.enums import (
    ApiProvider,
    JobStatus,
    JobType,
    ProjectStatus,
    ScriptStatus,
    SocialPlatform,
    SocialPostStatus,
    VideoStatus,
    VideoType,
)

if TYPE_CHECKING:
    pass


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    series: Mapped[list["Series"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    video_projects: Mapped[list[VideoProject]] = relationship(back_populates="user", cascade="all, delete-orphan")
    api_keys: Mapped[list[ApiKey]] = relationship(back_populates="user", cascade="all, delete-orphan")
    youtube_accounts: Mapped[list[YouTubeAccount]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    social_accounts: Mapped[list["SocialAccount"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Series(Base):
    __tablename__ = "project_series"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    theme: Mapped[str] = mapped_column(Text)
    default_max_duration_seconds: Mapped[int] = mapped_column(Integer, default=600)
    default_video_type: Mapped[VideoType | None] = mapped_column(
        SAEnum(VideoType, name="series_video_type", native_enum=False), nullable=True
    )
    default_include_subtitles: Mapped[bool] = mapped_column(Boolean, default=False)
    topic_dedup_recent_count: Mapped[int] = mapped_column(
        Integer, default=30, doc="How many prior sibling episodes to list so the AI avoids repeating recent angles."
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    episode_title_pattern: Mapped[str] = mapped_column(
        String(512), default="{series} — Episode {n}",
    )
    next_episode_number: Mapped[int] = mapped_column(Integer, default=1)
    pending_episode_topics: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    default_tts_speaker: Mapped[str] = mapped_column(String(64), default="Ryan")
    default_tts_language: Mapped[str] = mapped_column(String(64), default="English")
    default_narration_tone: Mapped[str | None] = mapped_column(Text, nullable=True)
    default_tts_voice_style: Mapped[dict[str, Any] | None] = mapped_column(
        JSON,
        nullable=True,
        doc="Optional UI state: main preset + emotion/speed/pitch/accent/delivery keys for TTS instruct composer.",
    )
    default_voice_gender: Mapped[str] = mapped_column(String(32), default="any")
    default_hf_tts_repo_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Hugging Face repo id for local Qwen-TTS weights; new episodes inherit."
    )
    default_hf_image_repo_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Hugging Face repo id for local SD3/diffusers image weights; new episodes inherit."
    )
    default_image_style: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        doc="Default art-style preset key for new episodes (e.g. ``ghibli``, ``anime``, ``photorealistic``).",
    )
    default_script_use_web_research: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        doc="New episodes inherit: Tavily web research before script vs model knowledge only.",
    )
    default_no_image_mode: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        doc="New episodes inherit: render audio + on-screen subtitle frames only (no SD3 image generation).",
    )
    schedule_runs_until_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    schedule_max_runs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    schedule_completed_runs: Mapped[int] = mapped_column(Integer, default=0)
    series_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    user: Mapped[User] = relationship(back_populates="series")
    video_projects: Mapped[list[VideoProject]] = relationship(back_populates="series")
    schedules: Mapped[list[Schedule]] = relationship(back_populates="series_obj", cascade="all, delete-orphan")


class VideoProject(Base):
    __tablename__ = "video_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    series_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project_series.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(255))
    theme: Mapped[str] = mapped_column(Text)
    max_duration_seconds: Mapped[int] = mapped_column(Integer, default=600)
    video_type: Mapped[VideoType] = mapped_column(
        SAEnum(VideoType, name="video_type_project", native_enum=False),
        default=VideoType.youtube_long_16_9,
    )
    content_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    episode_topic: Mapped[str | None] = mapped_column(Text, nullable=True)
    topic_dedup_recent_count: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        doc="Standalone videos only: how many prior account projects to list for topic de-duplication. Null = app default.",
    )
    tts_speaker: Mapped[str] = mapped_column(String(64), default="Ryan")
    tts_language: Mapped[str] = mapped_column(String(64), default="English")
    narration_tone: Mapped[str | None] = mapped_column(Text, nullable=True)
    tts_voice_style: Mapped[dict[str, Any] | None] = mapped_column(
        JSON,
        nullable=True,
        doc="Optional UI state: main preset + emotion/speed/pitch/accent/delivery keys for TTS instruct composer.",
    )
    voice_gender: Mapped[str] = mapped_column(String(32), default="any")
    hf_tts_repo_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Pinned HF repo for local TTS; empty = auto-pick under tts/."
    )
    hf_image_repo_id: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Pinned HF repo for scene images; empty = auto-pick under image/."
    )
    image_style: Mapped[str | None] = mapped_column(
        String(64),
        nullable=True,
        doc="Art-style preset key (e.g. ``ghibli``, ``anime``, ``photorealistic``). Null/auto = no style prefix.",
    )
    include_subtitles: Mapped[bool] = mapped_column(Boolean, default=False)
    use_ai_video_title: Mapped[bool] = mapped_column(Boolean, default=True)
    script_use_web_research: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        doc="If True, run Tavily before script LLM when globally enabled. If False, script uses model knowledge only.",
    )
    no_image_mode: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        doc="If True, skip image generation; the rendered video shows on-screen subtitle frames over a flat background.",
    )
    status: Mapped[ProjectStatus] = mapped_column(
        SAEnum(ProjectStatus, name="project_status", native_enum=False), default=ProjectStatus.draft
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    schedule_runs_until_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    schedule_max_runs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    schedule_completed_runs: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    user: Mapped[User] = relationship(back_populates="video_projects")
    series: Mapped[Series | None] = relationship(back_populates="video_projects")
    scripts: Mapped[list[Script]] = relationship(back_populates="project", cascade="all, delete-orphan")
    videos: Mapped[list[Video]] = relationship(back_populates="project", cascade="all, delete-orphan")
    schedules: Mapped[list[Schedule]] = relationship(back_populates="project", cascade="all, delete-orphan")
    jobs: Mapped[list[Job]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Script(Base):
    __tablename__ = "scripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("video_projects.id", ondelete="CASCADE"), index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[ScriptStatus] = mapped_column(
        SAEnum(ScriptStatus, name="script_status", native_enum=False), default=ScriptStatus.draft
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    project: Mapped[VideoProject] = relationship(back_populates="scripts")
    scenes: Mapped[list[Scene]] = relationship(back_populates="script", cascade="all, delete-orphan")


class Scene(Base):
    __tablename__ = "scenes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    script_id: Mapped[str] = mapped_column(String(36), ForeignKey("scripts.id", ondelete="CASCADE"), index=True)
    scene_number: Mapped[int] = mapped_column(Integer)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=30)
    narration_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    transition: Mapped[str] = mapped_column(String(64), default="fade")
    text_overlays: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)

    script: Mapped[Script] = relationship(back_populates="scenes")
    images: Mapped[list[SceneImage]] = relationship(back_populates="scene", cascade="all, delete-orphan")
    audio: Mapped[list[SceneAudio]] = relationship(back_populates="scene", cascade="all, delete-orphan")


class SceneImage(Base):
    __tablename__ = "scene_images"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    scene_id: Mapped[str] = mapped_column(String(36), ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    storage_path: Mapped[str] = mapped_column(Text)
    prompt_used: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    scene: Mapped[Scene] = relationship(back_populates="images")


class SceneAudio(Base):
    __tablename__ = "scene_audio"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    scene_id: Mapped[str] = mapped_column(String(36), ForeignKey("scenes.id", ondelete="CASCADE"), index=True)
    storage_path: Mapped[str] = mapped_column(Text)
    voice_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    scene: Mapped[Scene] = relationship(back_populates="audio")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("video_projects.id", ondelete="CASCADE"), index=True)
    file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    youtube_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[VideoStatus] = mapped_column(
        SAEnum(VideoStatus, name="video_status", native_enum=False), default=VideoStatus.pending
    )
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    project: Mapped[VideoProject] = relationship(back_populates="videos")


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("video_projects.id", ondelete="CASCADE"), nullable=True, index=True
    )
    series_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("project_series.id", ondelete="CASCADE"), nullable=True, index=True
    )
    cron_expression: Mapped[str] = mapped_column(String(128))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    next_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    effective_from_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    runs_until_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_runs: Mapped[int | None] = mapped_column(Integer, nullable=True)
    run_count: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped[VideoProject | None] = relationship(back_populates="schedules")
    series_obj: Mapped[Series | None] = relationship(back_populates="schedules")


class Job(Base):
    __tablename__ = "job_queue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("video_projects.id", ondelete="CASCADE"), index=True)
    job_type: Mapped[JobType] = mapped_column(SAEnum(JobType, name="job_type", native_enum=False))
    status: Mapped[JobStatus] = mapped_column(
        SAEnum(JobStatus, name="job_status", native_enum=False), default=JobStatus.queued
    )
    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    project: Mapped[VideoProject] = relationship(back_populates="jobs")
    logs: Mapped[list[JobLog]] = relationship(back_populates="job", cascade="all, delete-orphan")


class JobLog(Base):
    __tablename__ = "job_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    job_id: Mapped[str] = mapped_column(String(36), ForeignKey("job_queue.id", ondelete="CASCADE"), index=True)
    level: Mapped[str] = mapped_column(String(16), default="info")
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    job: Mapped[Job] = relationship(back_populates="logs")


class ApiKey(Base):
    __tablename__ = "api_configurations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[ApiProvider] = mapped_column(SAEnum(ApiProvider, name="api_provider", native_enum=False))
    key_encrypted: Mapped[str] = mapped_column(Text)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    user: Mapped[User] = relationship(back_populates="api_keys")


class YouTubeAccount(Base):
    __tablename__ = "youtube_channels"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    channel_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    channel_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tokens_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    user: Mapped[User] = relationship(back_populates="youtube_accounts")


class SocialAccount(Base):
    """OAuth / API credentials for a social platform (multi-platform publishing)."""

    __tablename__ = "social_accounts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform: Mapped[SocialPlatform] = mapped_column(
        SAEnum(SocialPlatform, name="social_platform", native_enum=False), index=True
    )
    account_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tokens_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    user: Mapped[User] = relationship(back_populates="social_accounts")
    posts: Mapped[list["SocialPost"]] = relationship(back_populates="account", cascade="all, delete-orphan")


class SocialPost(Base):
    """Cross-platform publish job linked to a video project."""

    __tablename__ = "social_posts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("video_projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    account_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("social_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    platform: Mapped[SocialPlatform] = mapped_column(
        SAEnum(SocialPlatform, name="social_post_platform", native_enum=False), index=True
    )
    title: Mapped[str] = mapped_column(String(512))
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[SocialPostStatus] = mapped_column(
        SAEnum(SocialPostStatus, name="social_post_status", native_enum=False),
        default=SocialPostStatus.draft,
    )
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    account: Mapped[SocialAccount | None] = relationship(back_populates="posts")
