"""In-app database and platform maintenance (no shell required)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    ApiKey,
    Job,
    JobLog,
    Scene,
    SceneAudio,
    SceneImage,
    Schedule,
    Script,
    Series,
    User,
    Video,
    VideoProject,
    YouTubeAccount,
)


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def alembic_config() -> Config:
    return Config(str(_backend_dir() / "alembic.ini"))


def run_migrations() -> None:
    """Apply Alembic migrations to the current DATABASE_URL (from settings / .env)."""
    command.upgrade(alembic_config(), "head")


def mask_database_url(url: str) -> str:
    """Hide passwords in URLs for display."""
    if not url:
        return ""
    return re.sub(r"(postgresql\+?[^:]+://)([^:]+):([^@]+)@", r"\1\2:***@", url, count=1)


def database_display_info() -> dict[str, Any]:
    url = settings.database_url
    parsed = make_url(url)
    is_sqlite = parsed.drivername.startswith("sqlite")
    backend = "sqlite" if is_sqlite else parsed.drivername
    out: dict[str, Any] = {
        "backend": backend,
        "url_masked": mask_database_url(url),
        "is_sqlite": is_sqlite,
    }
    if is_sqlite:
        db_path = parsed.database
        if db_path and db_path != ":memory:":
            p = Path(db_path)
            out["sqlite_path"] = str(p.resolve())
            out["sqlite_exists"] = p.is_file()
            out["sqlite_bytes"] = p.stat().st_size if p.is_file() else 0
        else:
            out["sqlite_path"] = db_path or ""
            out["sqlite_exists"] = False
            out["sqlite_bytes"] = 0
    return out


def get_alembic_revision(db: Session) -> str | None:
    try:
        return db.execute(text("SELECT version_num FROM alembic_version LIMIT 1")).scalar_one_or_none()
    except Exception:
        return None


def get_table_counts(db: Session) -> dict[str, int]:
    def c(model: type) -> int:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)

    return {
        "users": c(User),
        "video_projects": c(VideoProject),
        "scripts": c(Script),
        "scenes": c(Scene),
        "jobs": c(Job),
        "job_logs": c(JobLog),
        "series": c(Series),
        "schedules": c(Schedule),
        "videos": c(Video),
        "api_keys": c(ApiKey),
        "youtube_accounts": c(YouTubeAccount),
        "scene_images": c(SceneImage),
        "scene_audio": c(SceneAudio),
    }


def sqlite_vacuum() -> None:
    """Reclaim space for SQLite (no-op meaningful for empty DB)."""
    from app.database import engine

    if not settings.database_url.startswith("sqlite"):
        raise ValueError("VACUUM is only supported for SQLite.")
    with engine.connect() as conn:
        conn.execution_options(isolation_level="AUTOCOMMIT").execute(text("VACUUM"))


def reset_sqlite_database() -> None:
    """
    Delete the SQLite file and rebuild schema via Alembic.
    Caller must stop the job executor and ensure no app DB sessions are open.
    """
    from app.database import engine, rebind_engine

    url = settings.database_url
    if not url.startswith("sqlite"):
        raise ValueError("Reset from the UI is only supported for SQLite.")
    parsed = make_url(url)
    db_path = parsed.database
    if not db_path or db_path == ":memory:":
        raise ValueError("Cannot reset in-memory SQLite from this action.")
    path = Path(db_path).resolve()
    engine.dispose(close=True)
    if path.is_file():
        path.unlink()
    run_migrations()
    rebind_engine(url)
