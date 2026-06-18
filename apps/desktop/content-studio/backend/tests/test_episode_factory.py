"""Episode bootstrap + project clone helpers."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models.tables  # noqa: F401 — register mappers
from app.models import Series, User, VideoProject
from app.models.base import Base
from app.models.enums import ProjectStatus, VideoType
from app.services.episode_factory import (
    bootstrap_series_episodes,
    clone_video_project,
    create_series_episode_project,
)


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


@pytest.fixture()
def test_user(db_session):
    u = User(email="factory@test.com", hashed_password="h")
    db_session.add(u)
    db_session.commit()
    return u


def test_bootstrap_series_creates_one_episode_when_no_topics(db_session, test_user) -> None:
    series = Series(
        user_id=test_user.id,
        title="Mystery Lane",
        theme="Weekly conspiracies",
        default_max_duration_seconds=120,
        default_video_type=VideoType.youtube_shorts_vertical,
        pending_episode_topics=None,
        next_episode_number=1,
    )
    db_session.add(series)
    db_session.flush()

    eps = bootstrap_series_episodes(db_session, series)
    db_session.commit()

    assert len(eps) == 1
    assert eps[0].series_id == series.id
    assert eps[0].title == "Mystery Lane — Episode 1"
    assert series.next_episode_number == 2
    assert series.pending_episode_topics is None


def test_bootstrap_series_creates_one_episode_per_queued_topic(db_session, test_user) -> None:
    series = Series(
        user_id=test_user.id,
        title="Tech Tales",
        theme="Gadget deep dives",
        default_max_duration_seconds=300,
        default_video_type=VideoType.youtube_long_16_9,
        pending_episode_topics=["Phones", "Chips", "AI"],
        next_episode_number=1,
    )
    db_session.add(series)
    db_session.flush()

    eps = bootstrap_series_episodes(db_session, series)
    db_session.commit()

    assert len(eps) == 3
    assert [e.episode_topic for e in eps] == ["Phones", "Chips", "AI"]
    assert series.next_episode_number == 4
    assert series.pending_episode_topics is None


def test_clone_video_project_copies_generation_settings(db_session, test_user) -> None:
    source = VideoProject(
        user_id=test_user.id,
        title="Original",
        theme="Space myths",
        max_duration_seconds=90,
        video_type=VideoType.theory_narrative_engaging,
        tts_speaker="Ryan",
        tts_language="English",
        narration_tone="urgent whisper",
        tts_voice_style={"preset": "documentary", "emotion": "tense"},
        voice_gender="male",
        hf_tts_repo_id="Qwen/Qwen3-TTS",
        hf_image_repo_id="cutycat2000x/InterDiffusion-4.0",
        image_style="ghibli",
        include_subtitles=True,
        script_use_web_research=False,
        no_image_mode=True,
        status=ProjectStatus.ready,
    )
    db_session.add(source)
    db_session.commit()

    clone = clone_video_project(
        db_session,
        source=source,
        user_id=test_user.id,
        title="Copy of Original",
    )
    db_session.commit()

    assert clone.id != source.id
    assert clone.series_id is None
    assert clone.title == "Copy of Original"
    assert clone.theme == source.theme
    assert clone.image_style == "ghibli"
    assert clone.tts_voice_style == {"preset": "documentary", "emotion": "tense"}
    assert clone.tts_voice_style is not source.tts_voice_style
    assert clone.status == ProjectStatus.draft
    assert clone.schedule_completed_runs == 0

    rows = db_session.execute(select(VideoProject).where(VideoProject.user_id == test_user.id)).scalars().all()
    assert len(rows) == 2


def test_create_series_episode_still_increments_number(db_session, test_user) -> None:
    series = Series(
        user_id=test_user.id,
        title="Counter",
        theme="Counting",
        next_episode_number=5,
    )
    db_session.add(series)
    db_session.flush()
    ep = create_series_episode_project(db_session, series)
    assert ep.title.endswith("Episode 5")
    assert series.next_episode_number == 6
