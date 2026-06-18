"""Video type + brief fields on series and projects."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "002_video_type"
down_revision = "001_initial"
branch_labels = None
depends_on = None


def _column_missing(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column not in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    if _column_missing(bind, "project_series", "default_video_type"):
        op.add_column(
            "project_series",
            sa.Column("default_video_type", sa.String(length=64), nullable=True),
        )

    if _column_missing(bind, "video_projects", "video_type"):
        op.add_column(
            "video_projects",
            sa.Column(
                "video_type",
                sa.String(length=64),
                nullable=False,
                server_default="youtube_long_16_9",
            ),
        )
        op.alter_column("video_projects", "video_type", server_default=None)

    if _column_missing(bind, "video_projects", "content_notes"):
        op.add_column("video_projects", sa.Column("content_notes", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    if not _column_missing(bind, "video_projects", "content_notes"):
        op.drop_column("video_projects", "content_notes")

    if not _column_missing(bind, "video_projects", "video_type"):
        op.drop_column("video_projects", "video_type")

    if not _column_missing(bind, "project_series", "default_video_type"):
        op.drop_column("project_series", "default_video_type")
