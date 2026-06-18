"""Collect prior episode topic signals in a series for AI de-duplication prompts."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Script, VideoProject


def latest_script_titles_by_project(db: Session, project_ids: list[str]) -> dict[str, str]:
    if not project_ids:
        return {}
    subq = (
        select(Script.project_id, func.max(Script.version).label("mv"))
        .where(Script.project_id.in_(project_ids))
        .group_by(Script.project_id)
    ).subquery()
    rows = db.execute(
        select(Script.project_id, Script.content).join(
            subq,
            (Script.project_id == subq.c.project_id) & (Script.version == subq.c.mv),
        )
    ).all()
    out: dict[str, str] = {}
    for pid, content in rows:
        if isinstance(content, dict):
            t = content.get("title")
            if t:
                s = str(t).strip()
                if s:
                    out[str(pid)] = s
    return out


def build_recent_series_topics_prompt(
    db: Session,
    *,
    series_id: str,
    current_project_id: str,
    lookback: int,
) -> str:
    """
    Build a user-prompt block listing up to ``lookback`` other episodes in the series
    (most recently updated first): working title, optional episode_topic, latest script title.
    """
    lb = max(0, min(int(lookback), 500))
    if lb <= 0 or not series_id:
        return ""

    rows = list(
        db.execute(
            select(VideoProject)
            .where(
                VideoProject.series_id == series_id,
                VideoProject.id != current_project_id,
            )
            .order_by(VideoProject.updated_at.desc())
            .limit(lb)
        )
        .scalars()
        .all()
    )
    if not rows:
        return ""

    ids = [p.id for p in rows]
    script_titles = latest_script_titles_by_project(db, ids)
    lines: list[str] = []
    for p in rows:
        bits: list[str] = []
        et = (p.episode_topic or "").strip()
        if et:
            bits.append(f"episode focus: {et}")
        st = script_titles.get(p.id)
        if st:
            bits.append(f"last script title: {st}")
        head = (p.title or "").strip() or "(untitled)"
        suffix = f" — {'; '.join(bits)}" if bits else ""
        lines.append(f"- {head}{suffix}")

    body = "\n".join(lines)
    return (
        "RECENT EPISODES IN THIS SERIES (newest first in this list). "
        "Choose a substantively different specific angle, hook, and story beat than these; "
        "do not re-title or re-package the same core topic as any entry here unless it is clearly a deliberate "
        f"sequel/callback and still feels fresh. These are the last up to {lb} sibling episode(s) in the series:\n"
        f"{body}"
    )
