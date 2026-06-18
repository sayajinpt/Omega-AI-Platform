"""Per-episode focus line on video projects."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "004_episode_topic"
down_revision = "003_subtitles_ai_title"
branch_labels = None
depends_on = None


def _column_missing(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column not in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if _column_missing(bind, "video_projects", "episode_topic"):
        op.add_column("video_projects", sa.Column("episode_topic", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if not _column_missing(bind, "video_projects", "episode_topic"):
        op.drop_column("video_projects", "episode_topic")
