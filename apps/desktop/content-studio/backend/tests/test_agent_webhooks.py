from unittest.mock import MagicMock

from app.services import agent_webhooks


def test_webhook_targets_dedupes_global_and_per_run(monkeypatch) -> None:
    job = MagicMock()
    job.payload = {"webhook_url": "http://127.0.0.1/a"}
    monkeypatch.setattr(agent_webhooks.settings, "agent_webhook_url", "http://127.0.0.1/a", raising=False)
    assert agent_webhooks._webhook_targets(job) == ["http://127.0.0.1/a"]
