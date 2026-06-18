"""Series sibling topic lines for AI de-duplication prompts."""

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
from app.services.series_recent_topics import build_recent_series_topics_prompt
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


def test_build_recent_series_topics_includes_sibling_and_script_title(db_session) -> None:
    u = User(email="x@y.z", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    s = Series(
        user_id=u.id,
        title="Mysteries",
        theme="Bible",
        topic_dedup_recent_count=10,
    )
    db_session.add(s)
    db_session.commit()
    p1 = VideoProject(
        user_id=u.id,
        series_id=s.id,
        title="Episode 1",
        theme="Bible",
        episode_topic="Moon landing",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
        updated_at=datetime(2026, 1, 2, tzinfo=timezone.utc),
    )
    p2 = VideoProject(
        user_id=u.id,
        series_id=s.id,
        title="Episode 2",
        theme="Bible",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
        updated_at=datetime(2026, 1, 3, tzinfo=timezone.utc),
    )
    db_session.add_all([p1, p2])
    db_session.commit()
    db_session.add(
        Script(
            project_id=p1.id,
            content={"title": "The Moon Tapes"},
            version=1,
            status=ScriptStatus.draft,
        )
    )
    db_session.commit()

    txt = build_recent_series_topics_prompt(
        db_session, series_id=s.id, current_project_id=p2.id, lookback=10
    )
    assert "Episode 1" in txt
    assert "Moon landing" in txt
    assert "Moon Tapes" in txt


def test_build_video_brief_passes_db_includes_dedup_window(db_session) -> None:
    u = User(email="a@b.c", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    s = Series(user_id=u.id, title="S", theme="t", topic_dedup_recent_count=5)
    db_session.add(s)
    db_session.commit()
    p = VideoProject(
        user_id=u.id,
        series_id=s.id,
        series=s,
        title="New ep",
        theme="t",
        max_duration_seconds=60,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    db_session.add(p)
    db_session.commit()

    b = build_video_brief(p, db=db_session)
    assert b.series_topic_dedup_window == 5
