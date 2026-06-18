"""Hugging Face token resolution for downloads."""

from __future__ import annotations

import os


def test_hf_token_argument_prefers_env(monkeypatch) -> None:
    monkeypatch.setenv("HF_TOKEN", "tok_from_env")
    from localgen.hf_auth import hf_token_argument

    assert hf_token_argument() == "tok_from_env"


def test_hf_token_argument_alt_env(monkeypatch) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.setenv("HUGGING_FACE_HUB_TOKEN", "tok_alt")
    from localgen.hf_auth import hf_token_argument

    assert hf_token_argument() == "tok_alt"


def test_hf_token_argument_fallback(monkeypatch) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
    import huggingface_hub

    monkeypatch.setattr(huggingface_hub, "get_token", lambda: None)
    from localgen.hf_auth import hf_token_argument

    assert hf_token_argument() is None


def test_hf_token_argument_uses_hf_cli_cache(monkeypatch) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)

    def _fake_get_token():
        return "hf_cached"

    import huggingface_hub

    monkeypatch.setattr(huggingface_hub, "get_token", _fake_get_token)
    from localgen.hf_auth import hf_token_argument

    assert hf_token_argument() == "hf_cached"


def test_apply_saved_hf_token_respects_env(monkeypatch, tmp_path) -> None:
    from app.desktop import desktop_models_settings as dms

    p = tmp_path / "desktop_ui.json"
    p.write_text('{"hf_token": "saved_secret"}', encoding="utf-8")
    monkeypatch.setattr(dms, "desktop_ui_settings_path", lambda: p)
    monkeypatch.setenv("HF_TOKEN", "from_env")

    dms.apply_saved_hf_token_to_environ()
    assert os.environ["HF_TOKEN"] == "from_env"


def test_apply_saved_hf_token_injects_when_missing(monkeypatch, tmp_path) -> None:
    from app.desktop import desktop_models_settings as dms

    p = tmp_path / "desktop_ui.json"
    p.write_text('{"hf_token": "saved_secret"}', encoding="utf-8")
    monkeypatch.setattr(dms, "desktop_ui_settings_path", lambda: p)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)

    dms.apply_saved_hf_token_to_environ()
    assert os.environ.get("HF_TOKEN") == "saved_secret"
