"""Delete oldest video projects / episodes to reduce DB footprint (media cleanup is separate)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Series, VideoProject


def prune_user_projects_keep_newest(db: Session, *, user_id: str, keep_count: int) -> tuple[int, list[str]]:
    """Keep the ``keep_count`` projects most recently updated; delete the rest. Returns (deleted_count, deleted_ids)."""
    if keep_count < 1:
        return 0, []
    rows = (
        db.execute(
            select(VideoProject).where(VideoProject.user_id == user_id).order_by(VideoProject.updated_at.desc())
        )
        .scalars()
        .all()
    )
    if len(rows) <= keep_count:
        return 0, []
    victims = rows[keep_count:]
    ids: list[str] = []
    for p in victims:
        ids.append(p.id)
        db.delete(p)
    db.commit()
    return len(ids), ids


def prune_series_episodes_keep_newest(
    db: Session, *, series_id: str, user_id: str, keep_count: int
) -> tuple[int, list[str]]:
    """Keep ``keep_count`` newest episode rows (by ``created_at``) for the series; delete older episodes."""
    ser = db.get(Series, series_id)
    if not ser or ser.user_id != user_id:
        return 0, []
    if keep_count < 1:
        return 0, []
    rows = (
        db.execute(
            select(VideoProject)
            .where(VideoProject.series_id == series_id, VideoProject.user_id == user_id)
            .order_by(VideoProject.created_at.desc())
        )
        .scalars()
        .all()
    )
    if len(rows) <= keep_count:
        return 0, []
    victims = rows[keep_count:]
    ids: list[str] = []
    for p in victims:
        ids.append(p.id)
        db.delete(p)
    db.commit()
    return len(ids), ids
