"""Series setting: how many prior episodes to list for topic de-duplication in AI prompts."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "005_series_topic_dedup"
down_revision = "004_episode_topic"
branch_labels = None
depends_on = None


def _column_missing(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    return column not in {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if _column_missing(bind, "project_series", "topic_dedup_recent_count"):
        op.add_column(
            "project_series",
            sa.Column("topic_dedup_recent_count", sa.Integer(), nullable=False, server_default="30"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if not _column_missing(bind, "project_series", "topic_dedup_recent_count"):
        op.drop_column("project_series", "topic_dedup_recent_count")
