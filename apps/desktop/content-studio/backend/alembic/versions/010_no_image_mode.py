"""Per-project + per-series toggle: render video without image generation (audio + on-screen subtitles only)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "010_no_image_mode"
down_revision = "009_script_web_research_toggle"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "no_image_mode" not in vp:
        op.add_column(
            "video_projects",
            sa.Column("no_image_mode", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    ps = _cols(bind, "project_series")
    if "default_no_image_mode" not in ps:
        op.add_column(
            "project_series",
            sa.Column("default_no_image_mode", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "no_image_mode" in vp:
        op.drop_column("video_projects", "no_image_mode")

    ps = _cols(bind, "project_series")
    if "default_no_image_mode" in ps:
        op.drop_column("project_series", "default_no_image_mode")
