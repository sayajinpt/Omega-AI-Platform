"""Subtitles + AI title flags; series default subtitles."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "003_subtitles_ai_title"
down_revision = "002_video_type"
branch_labels = None
depends_on = None


def _column_missing(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column not in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    if _column_missing(bind, "project_series", "default_include_subtitles"):
        op.add_column(
            "project_series",
            sa.Column("default_include_subtitles", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    if _column_missing(bind, "video_projects", "include_subtitles"):
        op.add_column(
            "video_projects",
            sa.Column("include_subtitles", sa.Boolean(), nullable=False, server_default=sa.false()),
        )

    if _column_missing(bind, "video_projects", "use_ai_video_title"):
        op.add_column(
            "video_projects",
            sa.Column("use_ai_video_title", sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    if not _column_missing(bind, "video_projects", "use_ai_video_title"):
        op.drop_column("video_projects", "use_ai_video_title")

    if not _column_missing(bind, "video_projects", "include_subtitles"):
        op.drop_column("video_projects", "include_subtitles")

    if not _column_missing(bind, "project_series", "default_include_subtitles"):
        op.drop_column("project_series", "default_include_subtitles")
