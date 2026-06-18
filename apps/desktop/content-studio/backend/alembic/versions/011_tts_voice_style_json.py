"""Optional JSON on project + series for TTS voice-style dimension presets (emotion, speed, etc.)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "011_tts_voice_style_json"
down_revision = "010_no_image_mode"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "tts_voice_style" not in vp:
        op.add_column("video_projects", sa.Column("tts_voice_style", sa.JSON(), nullable=True))

    ps = _cols(bind, "project_series")
    if "default_tts_voice_style" not in ps:
        op.add_column("project_series", sa.Column("default_tts_voice_style", sa.JSON(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "tts_voice_style" in vp:
        op.drop_column("video_projects", "tts_voice_style")

    ps = _cols(bind, "project_series")
    if "default_tts_voice_style" in ps:
        op.drop_column("project_series", "default_tts_voice_style")
