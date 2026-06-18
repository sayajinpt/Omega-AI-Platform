"""TTS voice, language, narration tone, and gender preference on projects and series defaults."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "007_project_voice_settings"
down_revision = "006_lazy_series_schedule"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "tts_speaker" not in vp:
        op.add_column(
            "video_projects",
            sa.Column("tts_speaker", sa.String(64), nullable=False, server_default="Ryan"),
        )
    if "tts_language" not in vp:
        op.add_column(
            "video_projects",
            sa.Column("tts_language", sa.String(64), nullable=False, server_default="English"),
        )
    if "narration_tone" not in vp:
        op.add_column("video_projects", sa.Column("narration_tone", sa.Text(), nullable=True))
    if "voice_gender" not in vp:
        op.add_column(
            "video_projects",
            sa.Column("voice_gender", sa.String(32), nullable=False, server_default="any"),
        )

    ps = _cols(bind, "project_series")
    if "default_tts_speaker" not in ps:
        op.add_column(
            "project_series",
            sa.Column("default_tts_speaker", sa.String(64), nullable=False, server_default="Ryan"),
        )
    if "default_tts_language" not in ps:
        op.add_column(
            "project_series",
            sa.Column("default_tts_language", sa.String(64), nullable=False, server_default="English"),
        )
    if "default_narration_tone" not in ps:
        op.add_column("project_series", sa.Column("default_narration_tone", sa.Text(), nullable=True))
    if "default_voice_gender" not in ps:
        op.add_column(
            "project_series",
            sa.Column("default_voice_gender", sa.String(32), nullable=False, server_default="any"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    for col in ("voice_gender", "narration_tone", "tts_language", "tts_speaker"):
        if col in vp:
            op.drop_column("video_projects", col)

    ps = _cols(bind, "project_series")
    for col in ("default_voice_gender", "default_narration_tone", "default_tts_language", "default_tts_speaker"):
        if col in ps:
            op.drop_column("project_series", col)
