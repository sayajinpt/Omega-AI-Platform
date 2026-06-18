from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.models.enums import VideoType
from app.services.duration_policy import MAX_TECHNICAL_SECONDS


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    name: str | None = None


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    name: str | None
    created_at: datetime


class SeriesCreate(BaseModel):
    title: str
    theme: str
    default_max_duration_seconds: int = Field(default=600, ge=1, le=MAX_TECHNICAL_SECONDS)
    default_video_type: VideoType | None = None
    default_include_subtitles: bool = False
    default_no_image_mode: bool = Field(
        default=False,
        description="True = new episodes render audio + on-screen subtitle frames only (no SD3 image generation).",
    )
    default_tts_speaker: str = Field(default="Ryan", max_length=64)
    default_tts_language: str = Field(default="English", max_length=64)
    default_narration_tone: str | None = Field(default=None, description="Delivery style for scripts & TTS instruct.")
    default_tts_voice_style: dict[str, Any] | None = Field(
        default=None,
        description="Optional UI state: main preset + emotion/speed/pitch/accent/delivery keys.",
    )
    default_voice_gender: str = Field(default="any", max_length=32)
    default_hf_tts_repo_id: str | None = Field(default=None, max_length=255)
    default_hf_image_repo_id: str | None = Field(default=None, max_length=255)
    default_image_style: str | None = Field(
        default=None,
        max_length=64,
        description="Art-style preset key new episodes inherit (e.g. 'ghibli', 'anime', 'photorealistic').",
    )
    is_active: bool = True
    topic_dedup_recent_count: int = Field(
        default=30,
        ge=1,
        le=500,
        description="Prior sibling episodes to summarize for the AI so it avoids repeating recent topics.",
    )


class SeriesUpdate(BaseModel):
    title: str | None = None
    theme: str | None = None
    default_max_duration_seconds: int | None = Field(default=None, ge=1, le=MAX_TECHNICAL_SECONDS)
    default_video_type: VideoType | None = None
    default_include_subtitles: bool | None = None
    default_no_image_mode: bool | None = None
    default_tts_speaker: str | None = Field(default=None, max_length=64)
    default_tts_language: str | None = Field(default=None, max_length=64)
    default_narration_tone: str | None = None
    default_tts_voice_style: dict[str, Any] | None = None
    default_voice_gender: str | None = Field(default=None, max_length=32)
    default_hf_tts_repo_id: str | None = Field(default=None, max_length=255)
    default_hf_image_repo_id: str | None = Field(default=None, max_length=255)
    default_image_style: str | None = Field(default=None, max_length=64)
    is_active: bool | None = None
    topic_dedup_recent_count: int | None = Field(default=None, ge=1, le=500)


class SeriesRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    title: str
    theme: str
    default_max_duration_seconds: int
    default_video_type: str | None
    default_include_subtitles: bool
    default_no_image_mode: bool = False
    is_active: bool
    episode_title_pattern: str
    next_episode_number: int
    pending_episode_topics: list[str] | None = None
    series_notes: str | None = None
    schedule_runs_until_utc: datetime | None = None
    schedule_max_runs: int | None = None
    schedule_completed_runs: int
    topic_dedup_recent_count: int
    default_tts_speaker: str
    default_tts_language: str
    default_narration_tone: str | None
    default_tts_voice_style: dict[str, Any] | None = None
    default_voice_gender: str
    default_hf_tts_repo_id: str | None
    default_hf_image_repo_id: str | None
    default_image_style: str | None = None
    created_at: datetime
    updated_at: datetime


class VideoProjectCreate(BaseModel):
    title: str
    theme: str
    max_duration_seconds: int = Field(default=600, ge=1, le=MAX_TECHNICAL_SECONDS)
    series_id: str | None = None
    is_active: bool | None = Field(default=True)
    video_type: VideoType | None = None
    content_notes: str | None = Field(
        default=None,
        description="Optional constraints: tone, audience, banned topics, on-screen text style, etc.",
    )
    include_subtitles: bool | None = Field(
        default=None,
        description="If null and series_id is set, inherit series default_include_subtitles; else false.",
    )
    use_ai_video_title: bool | None = Field(
        default=None,
        description="If null, defaults to true (model proposes title/description in script JSON).",
    )
    episode_topic: str | None = Field(default=None, description="Optional per-episode angle; merged into the AI theme brief.")
    topic_dedup_recent_count: int | None = Field(
        default=None,
        ge=1,
        le=500,
        description="Standalone videos: how many prior account projects the script LLM sees to avoid repeats. Null = app default.",
    )
    tts_speaker: str = Field(default="Ryan", max_length=64)
    tts_language: str = Field(default="English", max_length=64)
    narration_tone: str | None = Field(default=None, description="e.g. warm, authoritative — guides script & TTS.")
    tts_voice_style: dict[str, Any] | None = Field(
        default=None,
        description="Optional UI state: main preset + emotion/speed/pitch/accent/delivery keys.",
    )
    voice_gender: str = Field(default="any", max_length=32)
    hf_tts_repo_id: str | None = Field(default=None, max_length=255)
    hf_image_repo_id: str | None = Field(default=None, max_length=255)
    image_style: str | None = Field(
        default=None,
        max_length=64,
        description="Art-style preset key (e.g. 'ghibli', 'anime', 'photorealistic'). Null/auto = no prefix.",
    )
    script_use_web_research: bool | None = Field(
        default=None,
        description="If null, defaults to true (Tavily web research before script when globally enabled).",
    )
    no_image_mode: bool | None = Field(
        default=None,
        description="If True, render audio + on-screen subtitle frames only (no image generation).",
    )


class VideoProjectUpdate(BaseModel):
    title: str | None = None
    theme: str | None = None
    max_duration_seconds: int | None = Field(default=None, ge=1, le=MAX_TECHNICAL_SECONDS)
    series_id: str | None = None
    video_type: VideoType | None = None
    content_notes: str | None = None
    include_subtitles: bool | None = None
    use_ai_video_title: bool | None = None
    episode_topic: str | None = None
    topic_dedup_recent_count: int | None = Field(default=None, ge=1, le=500)
    is_active: bool | None = None
    tts_speaker: str | None = Field(default=None, max_length=64)
    tts_language: str | None = Field(default=None, max_length=64)
    narration_tone: str | None = None
    tts_voice_style: dict[str, Any] | None = None
    voice_gender: str | None = Field(default=None, max_length=32)
    hf_tts_repo_id: str | None = Field(default=None, max_length=255)
    hf_image_repo_id: str | None = Field(default=None, max_length=255)
    image_style: str | None = Field(default=None, max_length=64)
    script_use_web_research: bool | None = None
    no_image_mode: bool | None = None


class VideoProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    series_id: str | None
    title: str
    theme: str
    max_duration_seconds: int
    video_type: str
    content_notes: str | None
    include_subtitles: bool
    use_ai_video_title: bool
    script_use_web_research: bool
    no_image_mode: bool = False
    episode_topic: str | None
    topic_dedup_recent_count: int | None = None
    status: str
    is_active: bool
    schedule_runs_until_utc: datetime | None = None
    schedule_max_runs: int | None = None
    schedule_completed_runs: int
    tts_speaker: str
    tts_language: str
    narration_tone: str | None
    tts_voice_style: dict[str, Any] | None = None
    voice_gender: str
    hf_tts_repo_id: str | None
    hf_image_repo_id: str | None
    image_style: str | None = None
    created_at: datetime
    updated_at: datetime


class ScheduleCreate(BaseModel):
    project_id: str | None = None
    series_id: str | None = None
    cron_expression: str
    timezone: str = "UTC"
    is_active: bool = True
    effective_from_utc: datetime | None = None
    runs_until_utc: datetime | None = None
    max_runs: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def project_or_series(self) -> ScheduleCreate:
        if bool(self.project_id) == bool(self.series_id):
            raise ValueError("Set exactly one of project_id or series_id.")
        return self


class ScheduleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str | None
    series_id: str | None
    cron_expression: str
    timezone: str
    is_active: bool
    effective_from_utc: datetime | None = None
    runs_until_utc: datetime | None = None
    max_runs: int | None = None
    run_count: int
    last_run: datetime | None
    next_run: datetime | None


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    job_type: str
    status: str
    celery_task_id: str | None
    created_at: datetime
    updated_at: datetime | None = None


class AgentPipelineMode(str):
    """Literal-style constants for agent run requests (use strings in JSON)."""

    SCRIPT_ONLY = "script_only"
    LOCAL_MEDIA = "local_media"
    FULL_PUBLISH = "full_publish"
    IMAGE_ONLY = "image_only"
    AUDIO_ONLY = "audio_only"


class AgentRunCreate(BaseModel):
    """
    Start a generation run for an external agent (Hermes, n8n, etc.).

    Provide ``project_id`` to use an existing project, or omit it and set ``theme`` (and
  optionally ``title``) to create a new standalone project automatically.
    """

    project_id: str | None = Field(default=None, description="Existing project UUID.")
    title: str | None = Field(default=None, max_length=255)
    theme: str | None = Field(default=None, description="Required when creating a new project.")
    content_notes: str | None = None
    episode_topic: str | None = None
    max_duration_seconds: int | None = Field(default=None, ge=1, le=MAX_TECHNICAL_SECONDS)
    video_type: VideoType | None = None
    video_format: str | None = Field(
        default=None,
        max_length=64,
        description="Structural format (shorts vs action montage vs documentary). Overrides auto-inference.",
    )
    include_subtitles: bool | None = Field(
        default=None,
        description="On-screen caption overlays (TikTok-style). Null = auto true for shorts ≤120s.",
    )
    use_ai_video_title: bool = True
    script_use_web_research: bool = True
    no_image_mode: bool = False
    tts_speaker: str | None = Field(default=None, max_length=64)
    tts_language: str | None = Field(default=None, max_length=64)
    narration_tone: str | None = Field(default=None, description="Delivery style for script & TTS instruct.")
    voice_gender: str | None = Field(default=None, max_length=32)
    image_style: str | None = Field(default=None, max_length=64)
    subtitle_language: str | None = Field(
        default=None,
        max_length=64,
        description="Written caption language; merged into content_notes when set.",
    )
    tts_voice_style: dict | None = Field(
        default=None,
        description="Structured TTS voice controls (e.g. speed: fast/slow) for Qwen instruct.",
    )
    pipeline_mode: str = Field(
        default=AgentPipelineMode.SCRIPT_ONLY,
        description="script_only | local_media | full_publish | image_only | audio_only",
    )
    wait_seconds: int = Field(
        default=0,
        ge=0,
        le=900,
        description="If >0, block until the job finishes or timeout (poll interval 2s).",
    )
    webhook_url: str | None = Field(
        default=None,
        description="Optional POST URL for job.finished (overrides AGENT_WEBHOOK_URL for this run).",
    )
    script_mode: str | None = Field(
        default=None,
        description="content_studio | omega_agent | agent_orchestrated — orchestrated uses script_content from Omega.",
    )
    script_content: dict | None = Field(
        default=None,
        description="Pre-built script JSON (scenes, title, …) from Omega agent; skips in-worker LLM.",
    )
    reuse_images_from_job_id: str | None = Field(
        default=None,
        description="Copy scene PNGs from a prior job on the same project (re-voice / new narration only).",
    )
    use_native_media: bool | None = Field(
        default=None,
        description="When true, render via omega-runtime native media (engine TTS + Ollama images + ffmpeg).",
    )

    @model_validator(mode="after")
    def project_or_theme(self) -> AgentRunCreate:
        if not self.project_id and not (self.theme or "").strip():
            raise ValueError("Set project_id or theme.")
        return self


class AgentRunCreated(BaseModel):
    job_id: str
    project_id: str
    status: str
    poll_url: str
    content_url: str


class AgentJobLogEntry(BaseModel):
    level: str
    message: str
    created_at: str | None = None


class AgentJobStatus(BaseModel):
    job_id: str
    project_id: str
    status: str
    created_at: str | None = None
    updated_at: str | None = None
    project_status: str | None = None
    script_ready: bool = False
    video_ready: bool = False
    mp4_path: str | None = None
    youtube_url: str | None = None
    pipeline_mode: str | None = None
    pipeline_phase: str | None = None
    deliverable: str | None = None
    error_message: str | None = None
    worker_running: bool = False
    logs: list[AgentJobLogEntry] = Field(default_factory=list)


class AgentProjectSummary(BaseModel):
    id: str
    title: str
    theme: str
    status: str
    updated_at: datetime | None = None


class AgentVideoDeliverable(BaseModel):
    mp4_path: str | None = None
    youtube_url: str | None = None


class AgentRunContent(BaseModel):
    job_id: str
    project_id: str
    status: str
    project: dict[str, Any]
    script: dict[str, Any] | None = None
    brief: dict[str, Any] | None = None
    video: AgentVideoDeliverable
    artifacts: dict[str, str | None] = Field(default_factory=dict)
