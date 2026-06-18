"""Per-project toggle: Tavily web research vs model-only script."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "009_script_web_research_toggle"
down_revision = "008_project_hf_models"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "script_use_web_research" not in vp:
        op.add_column(
            "video_projects",
            sa.Column("script_use_web_research", sa.Boolean(), nullable=False, server_default=sa.true()),
        )

    ps = _cols(bind, "project_series")
    if "default_script_use_web_research" not in ps:
        op.add_column(
            "project_series",
            sa.Column("default_script_use_web_research", sa.Boolean(), nullable=False, server_default=sa.true()),
        )


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "script_use_web_research" in vp:
        op.drop_column("video_projects", "script_use_web_research")

    ps = _cols(bind, "project_series")
    if "default_script_use_web_research" in ps:
        op.drop_column("project_series", "default_script_use_web_research")
