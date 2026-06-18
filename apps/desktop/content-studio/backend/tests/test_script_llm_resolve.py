"""Tests for Chat Completions credential resolution (Cursor vs OpenAI keys)."""

from app.services.script_llm import resolve_script_http_llm_from_values


def test_prefer_cursor_with_compat_base_uses_cursor():
    cfg = resolve_script_http_llm_from_values(
        prefer_cursor=True,
        cursor_api_key="crsr_secret",
        openai_api_key="sk-openai",
        cursor_openai_compatible_base="https://example.com/v1",
        openai_api_base="https://api.openai.com/v1",
        script_llm_model="gpt-4o-mini",
        cursor_model_id="composer-2",
        cursor_script_llm_use_basic_auth=True,
    )
    assert cfg is not None
    assert cfg.api_key == "crsr_secret"
    assert cfg.base_url == "https://example.com/v1"
    assert cfg.model == "composer-2"
    assert cfg.auth == "basic"
    assert cfg.orchestrator == "cursor_openai_compat"


def test_prefer_cursor_without_compat_base_falls_back_to_openai():
    cfg = resolve_script_http_llm_from_values(
        prefer_cursor=True,
        cursor_api_key="crsr_secret",
        openai_api_key="sk-openai",
        cursor_openai_compatible_base="",
        openai_api_base="https://api.openai.com/v1",
        script_llm_model="gpt-4o-mini",
        cursor_model_id="auto",
        cursor_script_llm_use_basic_auth=True,
    )
    assert cfg is not None
    assert cfg.api_key == "sk-openai"
    assert cfg.orchestrator == "cursor_preferred_openai_http_fallback"
    assert cfg.auth == "bearer"


def test_prefer_openai_uses_openai_first():
    cfg = resolve_script_http_llm_from_values(
        prefer_cursor=False,
        cursor_api_key="crsr_secret",
        openai_api_key="sk-openai",
        cursor_openai_compatible_base="https://example.com/v1",
        openai_api_base="https://api.openai.com/v1",
        script_llm_model="gpt-4o-mini",
        cursor_model_id="auto",
        cursor_script_llm_use_basic_auth=True,
    )
    assert cfg is not None
    assert cfg.api_key == "sk-openai"
    assert cfg.orchestrator == "openai_compat"


def test_only_cursor_without_compat_base_returns_none():
    cfg = resolve_script_http_llm_from_values(
        prefer_cursor=True,
        cursor_api_key="crsr_secret",
        openai_api_key="",
        cursor_openai_compatible_base="",
        openai_api_base="https://api.openai.com/v1",
        script_llm_model="gpt-4o-mini",
        cursor_model_id="auto",
        cursor_script_llm_use_basic_auth=True,
    )
    assert cfg is None
