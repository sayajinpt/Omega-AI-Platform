"""Optional per-project lookback for standalone topic de-duplication."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "013_project_topic_dedup"
down_revision = "012_image_style_preset"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    vp = _cols(bind, "video_projects")
    if "topic_dedup_recent_count" not in vp:
        op.add_column("video_projects", sa.Column("topic_dedup_recent_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    vp = _cols(bind, "video_projects")
    if "topic_dedup_recent_count" in vp:
        op.drop_column("video_projects", "topic_dedup_recent_count")
