"""Schedule evaluation (cron) against stored rows."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models.tables  # noqa: F401 — register mappers
from app.models.base import Base
from app.models.enums import ProjectStatus, VideoType
from app.models.tables import Schedule, User, VideoProject
from app.services.pipeline_jobs import build_job_payload_snapshot
from app.services.schedule_tick import run_schedule_tick


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


def test_schedule_tick_invalid_cron_reports_error(db_session) -> None:
    u = User(email="t@t.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    p = VideoProject(
        user_id=u.id,
        title="P",
        theme="theme",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    db_session.add(p)
    db_session.commit()
    s = Schedule(project_id=p.id, cron_expression="not five fields", timezone="UTC", is_active=True)
    db_session.add(s)
    db_session.commit()

    out = run_schedule_tick(db_session, user_id=u.id, now=datetime(2026, 5, 10, 12, 0, tzinfo=timezone.utc))
    assert out["enqueued_count"] == 0
    assert out["errors"]


def test_schedule_tick_syncs_last_run_first_pass(db_session) -> None:
    u = User(email="t2@t.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    p = VideoProject(
        user_id=u.id,
        title="P2",
        theme="theme",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    db_session.add(p)
    db_session.commit()
    s = Schedule(project_id=p.id, cron_expression="0 12 * * *", timezone="UTC", is_active=True)
    db_session.add(s)
    db_session.commit()

    now = datetime(2026, 5, 10, 15, 30, tzinfo=timezone.utc)
    out = run_schedule_tick(db_session, user_id=u.id, now=now)
    assert out["enqueued_count"] == 0
    db_session.refresh(s)
    assert s.last_run is not None


def test_pipeline_jobs_snapshot_includes_episode_topic() -> None:
    p = VideoProject(
        id="p9",
        user_id="u",
        title="T",
        theme="base",
        episode_topic="Angle A",
        max_duration_seconds=60,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    snap = build_job_payload_snapshot(p, "full_publish", post_publish=True)
    assert snap["project_snapshot"]["episode_topic"] == "Angle A"
    assert snap["post_publish"] is True
