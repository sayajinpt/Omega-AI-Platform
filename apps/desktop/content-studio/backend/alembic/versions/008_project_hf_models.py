"""Per-project Hugging Face repo ids for local TTS and image weights (+ series defaults)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision = "008_project_hf_models"
down_revision = "007_project_voice_settings"
branch_labels = None
depends_on = None


def _cols(bind, table: str) -> set[str]:
    insp = inspect(bind)
    return {c["name"] for c in insp.get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "hf_tts_repo_id" not in vp:
        op.add_column("video_projects", sa.Column("hf_tts_repo_id", sa.String(255), nullable=True))
    if "hf_image_repo_id" not in vp:
        op.add_column("video_projects", sa.Column("hf_image_repo_id", sa.String(255), nullable=True))

    ps = _cols(bind, "project_series")
    if "default_hf_tts_repo_id" not in ps:
        op.add_column("project_series", sa.Column("default_hf_tts_repo_id", sa.String(255), nullable=True))
    if "default_hf_image_repo_id" not in ps:
        op.add_column("project_series", sa.Column("default_hf_image_repo_id", sa.String(255), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    assert bind is not None

    vp = _cols(bind, "video_projects")
    if "hf_tts_repo_id" in vp:
        op.drop_column("video_projects", "hf_tts_repo_id")
    if "hf_image_repo_id" in vp:
        op.drop_column("video_projects", "hf_image_repo_id")

    ps = _cols(bind, "project_series")
    if "default_hf_tts_repo_id" in ps:
        op.drop_column("project_series", "default_hf_tts_repo_id")
    if "default_hf_image_repo_id" in ps:
        op.drop_column("project_series", "default_hf_image_repo_id")
