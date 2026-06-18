"""Optional per-project / per-series art-style preset key for image generation."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "012_image_style_preset"
down_revision = "011_tts_voice_style_json"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "image_style" not in vp:
        op.add_column("video_projects", sa.Column("image_style", sa.String(64), nullable=True))

    ps = _cols(bind, "project_series")
    if "default_image_style" not in ps:
        op.add_column("project_series", sa.Column("default_image_style", sa.String(64), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "image_style" in vp:
        op.drop_column("video_projects", "image_style")

    ps = _cols(bind, "project_series")
    if "default_image_style" in ps:
        op.drop_column("project_series", "default_image_style")
