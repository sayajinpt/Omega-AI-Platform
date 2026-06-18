"""Integration API for external agents (Hermes, etc.)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models.tables  # noqa: F401
from app.config import settings
from app.database import get_db
from app.main import app
from app.models.base import Base
from app.workers import queue as job_queue


@pytest.fixture()
def db_session(monkeypatch: pytest.MonkeyPatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    sess = TestSession()
    monkeypatch.setattr("app.workers.tasks.SessionLocal", TestSession)
    monkeypatch.setattr("app.services.agent_webhooks.SessionLocal", TestSession)
    try:
        yield sess
    finally:
        sess.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(db_session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    bind = db_session.get_bind()
    RequestSession = sessionmaker(autocommit=False, autoflush=False, bind=bind)

    def _override_get_db():
        db = RequestSession()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setattr(settings, "integration_auth_required", False, raising=False)
    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def sync_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run pipeline jobs inline so tests do not depend on background threads."""

    monkeypatch.setattr(job_queue, "_use_subprocess_jobs", lambda: False)

    def _submit(fn, *args, **kwargs) -> str:
        fn(*args, **kwargs)
        return "thread:inline"

    mock_exec = MagicMock()
    mock_exec.submit.side_effect = _submit
    monkeypatch.setattr(job_queue, "get_job_executor", lambda: mock_exec)


def test_agent_info_public(client: TestClient) -> None:
    r = client.get("/api/agent/v1/info")
    assert r.status_code == 200
    body = r.json()
    assert body["api_version"] == "v1"
    assert body["auth_required"] is False
    assert body["pipeline_worker_busy"] is False


def test_agent_create_run_rejects_while_worker_busy(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(job_queue, "any_pipeline_worker_running", lambda: True)
    r = client.post(
        "/api/agent/v1/runs",
        json={"title": "Busy", "theme": "test", "pipeline_mode": "script_only"},
    )
    assert r.status_code == 409


def test_agent_create_script_only_run(
    client: TestClient,
    sync_jobs: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_script = {
        "title": "Agent Video",
        "description": "Desc",
        "scenes": [
            {
                "scene_number": 1,
                "duration_seconds": 5,
                "narration_text": "Hook line one.",
                "image_prompt": "A dark corridor.",
                "transition": "fade",
                "text_overlays": [],
            }
        ],
        "meta": {"orchestrator": "test"},
    }
    monkeypatch.setattr("app.workers.tasks.generate_script_content", lambda *a, **k: dict(stub_script))
    posted: list[dict] = []
    monkeypatch.setattr(
        "app.services.agent_webhooks._post_webhook",
        lambda url, body: posted.append({"url": url, "body": body}),
    )
    import app.services.agent_webhooks as wh

    monkeypatch.setattr(
        "app.services.agent_webhooks.notify_agent_job_finished",
        lambda job_id: wh._deliver_job_webhooks(job_id),
    )

    r = client.post(
        "/api/agent/v1/runs",
        json={
            "title": "Hermes test",
            "theme": "Alien conspiracy angle",
            "max_duration_seconds": 30,
            "video_type": "youtube_shorts_vertical",
            "pipeline_mode": "script_only",
            "wait_seconds": 120,
            "webhook_url": "http://127.0.0.1:9999/hook",
        },
    )
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["job_id"]
    assert body["project_id"]
    assert body["status"] == "succeeded"

    content = client.get(f"/api/agent/v1/runs/{body['job_id']}/content")
    assert content.status_code == 200, content.text
    data = content.json()
    assert data["script"]["title"] == "Agent Video"
    assert len(data["script"]["scenes"]) == 1

    assert len(posted) == 1
    assert posted[0]["url"] == "http://127.0.0.1:9999/hook"
    assert posted[0]["body"]["event"] == "job.finished"
    assert posted[0]["body"]["status"] == "succeeded"


def test_agent_requires_key_when_auth_enabled(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "integration_auth_required", True, raising=False)
    monkeypatch.setattr(settings, "integration_api_key", "secret-key", raising=False)
    r = client.post(
        "/api/agent/v1/runs",
        json={"theme": "Test topic", "pipeline_mode": "script_only"},
    )
    assert r.status_code == 401
