"""Pipeline updates VideoProject.status for visible UI feedback."""

from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models.tables  # noqa: F401
from app.models.base import Base
from app.models.enums import JobStatus, JobType, ProjectStatus, VideoType
from app.models.tables import Job, User, VideoProject
from app.workers.tasks import execute_pipeline_job


def test_execute_pipeline_job_updates_project_status(monkeypatch) -> None:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    monkeypatch.setattr("app.workers.tasks.SessionLocal", TestSession)

    db = TestSession()
    u = User(email="p@p.p", hashed_password="x")
    db.add(u)
    db.commit()
    p = VideoProject(
        user_id=u.id,
        title="Vid",
        theme="t",
        max_duration_seconds=60,
        video_type=VideoType.youtube_long_16_9,
        status=ProjectStatus.draft,
    )
    db.add(p)
    db.commit()
    job = Job(
        project_id=p.id,
        job_type=JobType.full_pipeline,
        status=JobStatus.queued,
        payload={
            "post_publish": False,
            "skip_local_media": True,
            "skip_llm_script": True,
        },
    )
    db.add(job)
    db.commit()
    jid = job.id

    execute_pipeline_job(jid)

    db.expire_all()
    p2 = db.get(VideoProject, p.id)
    j2 = db.get(Job, jid)
    assert p2 is not None and j2 is not None
    assert p2.status == ProjectStatus.ready
    assert j2.status == JobStatus.succeeded

    db.close()
    engine.dispose()
