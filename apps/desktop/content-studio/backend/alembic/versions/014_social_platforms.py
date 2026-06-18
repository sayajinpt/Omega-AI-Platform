"""Social accounts and cross-platform posts."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "014_social_platforms"
down_revision = "013_project_topic_dedup"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return name in inspect(bind).get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if not _has_table(bind, "social_accounts"):
        op.create_table(
            "social_accounts",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("platform", sa.String(32), nullable=False),
            sa.Column("account_label", sa.String(255), nullable=True),
            sa.Column("external_id", sa.String(255), nullable=True),
            sa.Column("tokens_encrypted", sa.Text(), nullable=True),
            sa.Column("meta", sa.JSON(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_social_accounts_user_id", "social_accounts", ["user_id"])
        op.create_index("ix_social_accounts_platform", "social_accounts", ["platform"])
    if not _has_table(bind, "social_posts"):
        op.create_table(
            "social_posts",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column(
                "project_id",
                sa.String(36),
                sa.ForeignKey("video_projects.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column(
                "account_id",
                sa.String(36),
                sa.ForeignKey("social_accounts.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.Column("platform", sa.String(32), nullable=False),
            sa.Column("title", sa.String(512), nullable=False),
            sa.Column("caption", sa.Text(), nullable=True),
            sa.Column("media_path", sa.Text(), nullable=True),
            sa.Column("status", sa.String(32), nullable=False, server_default="draft"),
            sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("published_url", sa.Text(), nullable=True),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_social_posts_user_id", "social_posts", ["user_id"])
        op.create_index("ix_social_posts_platform", "social_posts", ["platform"])


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None
    if _has_table(bind, "social_posts"):
        op.drop_table("social_posts")
    if _has_table(bind, "social_accounts"):
        op.drop_table("social_accounts")
