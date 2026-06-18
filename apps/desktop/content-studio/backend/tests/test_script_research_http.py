"""HTTP plumbing for Tavily search — body sent, error reporting on 400-class responses."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from app.services import script_research


def _set_required_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(script_research.settings, "tavily_api_key", "test-key", raising=False)
    monkeypatch.setattr(script_research.settings, "tavily_search_depth", "basic", raising=False)
    monkeypatch.setattr(script_research.settings, "tavily_max_results", 5, raising=False)
    monkeypatch.setattr(script_research.settings, "tavily_topic", "general", raising=False)
    monkeypatch.setattr(script_research.settings, "tavily_include_answer", True, raising=False)
    monkeypatch.setattr(
        script_research.settings, "tavily_exclude_entertainment_domains", False, raising=False
    )
    monkeypatch.setattr(script_research.settings, "tavily_exclude_domains", "", raising=False)


class _FakeResponse:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self._body = body
        self.text = body if isinstance(body, str) else ""

    def json(self) -> Any:
        if isinstance(self._body, dict):
            return self._body
        raise ValueError("not json")


class _FakeClient:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *a: Any) -> None: ...

    def post(self, url: str, *, json: dict[str, Any], headers: dict[str, str]) -> _FakeResponse:
        self.calls.append({"url": url, "json": json, "headers": headers})
        return self.response


def test_tavily_search_logs_body_on_http_400(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """When Tavily returns 400, the warning log must include the response detail so the operator
    can see the actual cause (e.g. 'Query is too long. Max query length is 400 characters.')."""
    _set_required_settings(monkeypatch)

    response = _FakeResponse(400, {"detail": "Query is too long. Max query length is 400 characters."})
    fake_client = _FakeClient(response)
    monkeypatch.setattr(script_research.httpx, "Client", lambda **_kw: fake_client)

    with caplog.at_level(logging.WARNING, logger=script_research.logger.name):
        out = script_research._tavily_search_once("a" * 250)

    assert out is None
    assert any("400" in rec.getMessage() for rec in caplog.records)
    assert any("Query is too long" in rec.getMessage() for rec in caplog.records)
    assert any("query_len=250" in rec.getMessage() for rec in caplog.records)


def test_tavily_search_logs_text_body_when_response_not_json(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _set_required_settings(monkeypatch)

    response = _FakeResponse(500, "internal server error - retry later")
    monkeypatch.setattr(script_research.httpx, "Client", lambda **_kw: _FakeClient(response))

    with caplog.at_level(logging.WARNING, logger=script_research.logger.name):
        out = script_research._tavily_search_once("test")

    assert out is None
    assert any("500" in rec.getMessage() for rec in caplog.records)
    assert any("internal server error" in rec.getMessage() for rec in caplog.records)


def test_tavily_search_request_body_uses_documented_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sanity-check the request body so a future settings change doesn't silently 400 again."""
    _set_required_settings(monkeypatch)
    monkeypatch.setattr(script_research.settings, "tavily_max_results", 5, raising=False)

    response = _FakeResponse(200, {"results": []})
    fake_client = _FakeClient(response)
    monkeypatch.setattr(script_research.httpx, "Client", lambda **_kw: fake_client)

    script_research._tavily_search_once("a test query")
    body = fake_client.calls[0]["json"]
    assert body["query"] == "a test query"
    assert body["search_depth"] in ("basic", "advanced")
    assert 1 <= body["max_results"] <= 20
    assert body["topic"] in ("general", "news", "finance")


def test_tavily_search_returns_none_without_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(script_research.settings, "tavily_api_key", "", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    assert script_research._tavily_search_once("anything") is None
