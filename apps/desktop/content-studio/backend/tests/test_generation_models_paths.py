from pathlib import Path

import pytest


def test_generation_models_root_prefers_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("GENERATION_MODELS_DATA_DIR", str(tmp_path))
    from app.services.generation_models_paths import generation_models_root

    assert generation_models_root() == tmp_path.resolve()


def test_generation_models_root_settings_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("GENERATION_MODELS_DATA_DIR", raising=False)
    monkeypatch.setattr("app.config.settings.generation_models_data_dir", str(tmp_path))
    from app.services.generation_models_paths import generation_models_root

    assert generation_models_root() == tmp_path.resolve()
