"""Prior project topic lines for standalone-video AI de-duplication (account-wide memory)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import VideoProject
from app.services.series_recent_topics import latest_script_titles_by_project


def _format_project_line(p: VideoProject, script_titles: dict[str, str]) -> str:
    bits: list[str] = []
    et = (p.episode_topic or "").strip()
    if et:
        bits.append(f"episode focus: {et}")
    theme = (p.theme or "").strip()
    if theme:
        preview = theme if len(theme) <= 160 else theme[:157] + "…"
        bits.append(f"theme: {preview}")
    st = script_titles.get(p.id)
    if st:
        bits.append(f"last script title: {st}")
    if p.series_id:
        bits.append("type: series episode")
    else:
        bits.append("type: single video")
    head = (p.title or "").strip() or "(untitled)"
    return f"- {head} — {'; '.join(bits)}"


def build_recent_user_projects_prompt(
    db: Session,
    *,
    user_id: str,
    current_project_id: str,
    lookback: int,
) -> str:
    """
    List up to ``lookback`` other projects for this user (newest ``updated_at`` first).

    Used before script generation for standalone videos so the LLM avoids repeating topics,
    hooks, and angles already covered in the project table (including series episodes).
    """
    lb = max(0, min(int(lookback), 500))
    if lb <= 0 or not user_id:
        return ""

    rows = list(
        db.execute(
            select(VideoProject)
            .where(
                VideoProject.user_id == user_id,
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

    script_titles = latest_script_titles_by_project(db, [p.id for p in rows])
    body = "\n".join(_format_project_line(p, script_titles) for p in rows)
    return (
        "PRIOR PROJECTS ON THIS ACCOUNT (newest first in this list). "
        "Choose a substantively different specific angle, hook, and story beat than these; "
        "do not re-title or re-package the same core topic as any entry here unless it is clearly a "
        f"deliberate sequel/callback and still feels fresh. These are the last up to {lb} other "
        f"project(s) in your library:\n"
        f"{body}"
    )
