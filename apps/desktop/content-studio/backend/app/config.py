from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _BACKEND_DIR.parent
_ENV_REPO = _REPO_ROOT / ".env"
_ENV_BACKEND = _BACKEND_DIR / ".env"
# Repo .env first, then backend/.env — backend wins on duplicate keys.
_ENV_FILES: tuple[Path, ...] = tuple(p for p in (_ENV_REPO, _ENV_BACKEND) if p.is_file()) or (_ENV_BACKEND,)


def _default_sqlite_database_url() -> str:
    """Single-file DB — packaged installs use ~/.omega/content-studio/data (writable)."""
    import os

    override = (os.environ.get("OMEGA_CS_DATA_DIR") or "").strip()
    if override:
        data_dir = Path(override)
    else:
        omega_home = (os.environ.get("OMEGA_HOME") or "").strip() or str(Path.home() / ".omega")
        data_dir = Path(omega_home) / "content-studio" / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = (data_dir / "media_auto.db").resolve()
    return f"sqlite:///{db_path.as_posix()}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILES, env_file_encoding="utf-8", extra="ignore")

    database_url: str = Field(default_factory=_default_sqlite_database_url)
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 24 * 7
    api_prefix: str = "/api"
    cors_origins: str = "http://localhost:3000"
    storage_path: str = "./storage"
    # One GPU job at a time — parallel jobs only contend for VRAM and inflate step latency.
    max_concurrent_jobs: int = 1

    # When True, uvicorn runs a background thread that evaluates DB schedules every 60s.
    # Leave False if you rely on the desktop app (which ticks every 45s for the signed-in user).
    api_schedule_runner: bool = False

    # Local TTS / image weights (see generation_models/README.md)
    generation_models_data_dir: str = "~/.omega/models/generation-models"

    # Cursor Integrations API key (same key used by Cursor CLI / Cloud Agents). There is no public
    # OpenAI-style /chat/completions on api.cursor.com — set cursor_openai_compatible_base if your
    # provider exposes Chat Completions for this key, or set OPENAI_API_KEY for standard providers.
    cursor_api_key: str = ""
    cursor_model_id: str = "auto"
    # When True, CURSOR_API_KEY wins over OPENAI_API_KEY for LLM script generation when both are set.
    prefer_cursor_for_script_llm: bool = True
    # OpenAI-compatible API root (must end with /v1). Required when using CURSOR_API_KEY without OPENAI_API_KEY.
    cursor_openai_compatible_base: str = ""
    # Gateways that expect Integrations keys often document Basic auth (username=key, password empty).
    cursor_script_llm_use_basic_auth: bool = True

    # OpenAI-compatible Chat Completions (script JSON). Works with OpenAI, Groq, OpenRouter, Azure, etc.
    openai_api_key: str = ""
    openai_api_base: str = "https://api.openai.com/v1"
    script_llm_model: str = "gpt-4o-mini"
    # script_llm_backend: auto (prefer Cursor CLI if agent+CURSOR_API_KEY), openai_compat (HTTP only), cursor_cli (agent -p only).
    script_llm_backend: str = "auto"
    cursor_cli_path: str = ""
    cursor_cli_cwd: str = ""
    cursor_cli_timeout_seconds: int = 600
    # Cursor CLI requires acknowledging workspace access for non-interactive runs. Default --trust; use --yolo or -f if needed.
    cursor_cli_trust_flag: str = "--trust"
    cursor_cli_max_attempts: int = 4

    # When True and no API key, use empty outline_stub scripts (no LLM). Default True so local rendering works offline.
    allow_outline_script_fallback: bool = True

    # Optional Tavily web search before script generation (Cursor CLI cannot browse the web in ``agent -p`` mode).
    script_web_research_enabled: bool = True
    tavily_api_key: str = ""
    tavily_search_depth: str = "basic"
    tavily_max_results: int = 6
    tavily_topic: str = "general"
    # Prefer nonfiction SERPs: exclude common movie/TV listing domains (comma-separated hostnames).
    tavily_exclude_entertainment_domains: bool = True
    tavily_exclude_domains: str = "imdb.com,rottentomatoes.com,letterboxd.com,boxofficemojo.com,metacritic.com"
    tavily_include_answer: bool = True

    # SD3 engine only. 0 = use catalog default_num_steps (qwen_tts_gui uses 8 for turbo). Non-zero overrides SD3 only.
    sd3_num_steps: int = 0
    # All image engines (SDXL, InterDiffusion, Z-Image, …). 0 = use each model's catalog default.
    image_num_steps: int = 0
    # JSON map repo_id → steps (from Omega Settings). Overrides image_num_steps when set for active repo.
    image_steps_by_repo_json: str = ""
    # All text-to-video engines. 0 = use each model's catalog default.
    video_num_steps: int = 0
    # JSON map repo_id → steps for T2V (from Omega Settings).
    video_steps_by_repo_json: str = ""
    # JSON map repo_id → {width, height}. 0/0 = catalog default.
    video_size_by_repo_json: str = ""
    # JSON map repo_id → {width, height}. 0/0 = catalog default; -1/-1 = video brief aspect.
    image_size_by_repo_json: str = ""
    # JSON list of {baseRepoId, adapterRepoId, adapterFile?, scale?} for diffusers LoRA stacks.
    image_lora_adapters_json: str = ""

    # Standalone videos: how many other projects (same user) to list so script LLM avoids repeat topics.
    project_topic_dedup_recent_count: int = 30

    # External agents (Hermes, local LLM orchestrators) on /api/agent/v1/*.
    # Default: no auth (localhost-only). Set INTEGRATION_AUTH_REQUIRED=true + INTEGRATION_API_KEY to lock down.
    integration_auth_required: bool = False
    integration_api_key: str = ""
    integration_user_email: str = "local@media-automation.internal"
    # Optional POST target when agent pipeline jobs finish (Hermes can listen here).
    agent_webhook_url: str = ""
    agent_webhook_timeout_seconds: int = 10

    # Optional YouTube Data API upload (OAuth refresh flow). Leave empty to skip upload and keep local MP4 only.
    youtube_client_id: str = ""
    youtube_client_secret: str = ""
    youtube_refresh_token: str = ""
    youtube_upload_privacy: str = "private"
    youtube_oauth_redirect_uri: str = "http://127.0.0.1:8765/oauth2callback"

    # Meta (Instagram / Facebook / Threads via Graph API)
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_access_token: str = ""
    meta_page_id: str = ""
    instagram_business_account_id: str = ""

    # TikTok Content Posting API
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""
    tiktok_access_token: str = ""

    # X (Twitter) API v1.1 media + v2 tweet (OAuth 1.0a user context)
    x_api_key: str = ""
    x_api_secret: str = ""
    x_access_token: str = ""
    x_access_token_secret: str = ""

    # LinkedIn Marketing / UGC (optional)
    linkedin_client_id: str = ""
    linkedin_client_secret: str = ""
    linkedin_access_token: str = ""

    # Omega Content Studio → default generation models (overlay from Settings UI)
    default_hf_tts_repo_id: str = ""
    default_hf_image_repo_id: str = ""
    default_hf_video_repo_id: str = ""
    # content_studio | omega_agent | agent_orchestrated
    content_script_mode: str = "content_studio"
    content_omega_model_id: str = ""
    # all_gpu | auto | offload_encoders — synced from Omega Settings → Omega tools
    image_vram_mode: str = "all_gpu"

    @field_validator("database_url", mode="after")
    @classmethod
    def database_url_non_empty(cls, v: str) -> str:
        if not (v or "").strip():
            return _default_sqlite_database_url()
        return v.strip()


settings = Settings()

# Apply Omega-injected credentials when settings module loads (and after each credentials POST).
try:
    from app.services.runtime_credentials import patch_settings_object

    patch_settings_object(settings)
except Exception:
    pass
