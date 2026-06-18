"""Account-wide project memory for standalone script de-duplication."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models.tables  # noqa: F401
from app.models.base import Base
from app.models.enums import ProjectStatus, ScriptStatus, VideoType
from app.models.tables import Script, Series, User, VideoProject
from app.services.project_recent_topics import build_recent_user_projects_prompt
from app.services.video_brief import build_video_brief


@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    sess = Session()
    try:
        yield sess
    finally:
        sess.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_build_recent_user_projects_lists_other_projects(db_session) -> None:
    u = User(email="solo@test.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()

    older = VideoProject(
        user_id=u.id,
        title="Roswell deep dive",
        theme="1947 crash cover-up",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        status=ProjectStatus.draft,
        updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    newer = VideoProject(
        user_id=u.id,
        title="Area 51 gates",
        theme="military base myths",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        status=ProjectStatus.draft,
        updated_at=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )
    current = VideoProject(
        user_id=u.id,
        title="New mystery",
        theme="something fresh",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        status=ProjectStatus.draft,
    )
    db_session.add_all([older, newer, current])
    db_session.commit()
    db_session.add(
        Script(
            project_id=older.id,
            content={"title": "The Crash They Hid"},
            version=1,
            status=ScriptStatus.draft,
        )
    )
    db_session.commit()

    txt = build_recent_user_projects_prompt(
        db_session, user_id=u.id, current_project_id=current.id, lookback=10
    )
    assert "PRIOR PROJECTS ON THIS ACCOUNT" in txt
    assert "Area 51 gates" in txt
    assert "Roswell deep dive" in txt
    assert "Crash They Hid" in txt
    assert "New mystery" not in txt


def test_build_recent_user_projects_includes_series_episodes(db_session) -> None:
    """Standalone generation should see series episodes too — not only other singles."""
    u = User(email="mix@test.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    s = Series(user_id=u.id, title="Mystery Lane", theme="Weekly conspiracies")
    db_session.add(s)
    db_session.commit()
    ep = VideoProject(
        user_id=u.id,
        series_id=s.id,
        title="Episode 3",
        theme="Weekly conspiracies",
        episode_topic="Denver airport",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    solo = VideoProject(
        user_id=u.id,
        title="New solo",
        theme="Fresh angle",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        status=ProjectStatus.draft,
    )
    db_session.add_all([ep, solo])
    db_session.commit()

    txt = build_recent_user_projects_prompt(
        db_session, user_id=u.id, current_project_id=solo.id, lookback=10
    )
    assert "Episode 3" in txt
    assert "Denver airport" in txt
    assert "type: series episode" in txt


def test_standalone_video_brief_includes_prior_projects_block(db_session) -> None:
    u = User(email="brief@test.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    prior = VideoProject(
        user_id=u.id,
        title="Already did this",
        theme="moon landing hoax",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        status=ProjectStatus.draft,
    )
    current = VideoProject(
        user_id=u.id,
        title="Working",
        theme="alien theories",
        max_duration_seconds=60,
        video_type=VideoType.youtube_shorts_vertical,
        topic_dedup_recent_count=5,
        status=ProjectStatus.draft,
    )
    db_session.add_all([prior, current])
    db_session.commit()

    b = build_video_brief(current, db=db_session)
    assert b.prior_projects_dedup_window == 5
    assert "PRIOR PROJECTS ON THIS ACCOUNT" in b.prior_projects_topics_block
    assert "Already did this" in b.prior_projects_topics_block
    user_prompt = b.llm_script_user_prompt()
    assert "# PRIOR PROJECTS ON THIS ACCOUNT" in user_prompt
    assert "moon landing" in user_prompt


def test_series_episode_brief_does_not_use_account_prior_block(db_session) -> None:
    u = User(email="ser@test.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    s = Series(user_id=u.id, title="S", theme="t", topic_dedup_recent_count=3)
    db_session.add(s)
    db_session.commit()
    p = VideoProject(
        user_id=u.id,
        series_id=s.id,
        series=s,
        title="Ep 2",
        theme="t",
        max_duration_seconds=60,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    db_session.add(p)
    db_session.commit()

    b = build_video_brief(p, db=db_session)
    assert b.series_topic_dedup_window == 3
    assert b.prior_projects_dedup_window == 0
    assert not b.prior_projects_topics_block.strip()
