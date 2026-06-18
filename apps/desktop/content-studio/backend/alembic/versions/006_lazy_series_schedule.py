"""Lazy episode creation for series schedules; project/site activity flags; schedule limits."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "006_lazy_series_schedule"
down_revision = "005_series_topic_dedup"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    c = _cols(bind, "video_projects")
    if "is_active" not in c:
        op.add_column(
            "video_projects",
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        )

    cs = _cols(bind, "project_series")
    if "is_active" not in cs:
        op.add_column(
            "project_series",
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default="1"),
        )
    if "episode_title_pattern" not in cs:
        op.add_column(
            "project_series",
            sa.Column("episode_title_pattern", sa.String(512), nullable=False, server_default="{series} — Episode {n}"),
        )
    if "next_episode_number" not in cs:
        op.add_column(
            "project_series",
            sa.Column("next_episode_number", sa.Integer(), nullable=False, server_default="1"),
        )
    if "pending_episode_topics" not in cs:
        op.add_column(
            "project_series",
            sa.Column("pending_episode_topics", sa.JSON(), nullable=True),
        )
    if "schedule_runs_until_utc" not in cs:
        op.add_column("project_series", sa.Column("schedule_runs_until_utc", sa.DateTime(timezone=True), nullable=True))
    if "schedule_max_runs" not in cs:
        op.add_column("project_series", sa.Column("schedule_max_runs", sa.Integer(), nullable=True))
    if "schedule_completed_runs" not in cs:
        op.add_column(
            "project_series",
            sa.Column("schedule_completed_runs", sa.Integer(), nullable=False, server_default="0"),
        )
    if "series_notes" not in cs:
        op.add_column("project_series", sa.Column("series_notes", sa.Text(), nullable=True))

    pv = _cols(bind, "video_projects")
    if "schedule_runs_until_utc" not in pv:
        op.add_column("video_projects", sa.Column("schedule_runs_until_utc", sa.DateTime(timezone=True), nullable=True))
    if "schedule_max_runs" not in pv:
        op.add_column("video_projects", sa.Column("schedule_max_runs", sa.Integer(), nullable=True))
    if "schedule_completed_runs" not in pv:
        op.add_column(
            "video_projects",
            sa.Column("schedule_completed_runs", sa.Integer(), nullable=False, server_default="0"),
        )

    sch = _cols(bind, "schedules")
    with op.batch_alter_table("schedules") as batch:
        if "series_id" not in sch:
            batch.add_column(sa.Column("series_id", sa.String(36), nullable=True))
            batch.create_foreign_key(
                "fk_schedules_series",
                "project_series",
                ["series_id"],
                ["id"],
                ondelete="CASCADE",
            )
        if "effective_from_utc" not in sch:
            batch.add_column(sa.Column("effective_from_utc", sa.DateTime(timezone=True), nullable=True))
        if "runs_until_utc" not in sch:
            batch.add_column(sa.Column("runs_until_utc", sa.DateTime(timezone=True), nullable=True))
        if "max_runs" not in sch:
            batch.add_column(sa.Column("max_runs", sa.Integer(), nullable=True))
        if "run_count" not in sch:
            batch.add_column(sa.Column("run_count", sa.Integer(), nullable=False, server_default="0"))
        batch.alter_column("project_id", existing_type=sa.String(36), nullable=True)

    op.execute(sa.text("UPDATE job_queue SET job_type = 'full_pipeline' WHERE job_type = 'dry_run'"))


def downgrade() -> None:
    # Best-effort: cannot safely re-add NOT NULL to project_id if nulls exist.
    raise NotImplementedError("Downgrade not supported for 006.")
