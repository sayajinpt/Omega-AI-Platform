import os

from app.config import settings
from app.services.runtime_credentials import (
    apply_credentials,
    bootstrap_settings_from_env,
    overlay_to_env,
    patch_settings_object,
)


def test_overlay_to_env_passes_image_steps(monkeypatch) -> None:
    apply_credentials({"IMAGE_STEPS_BY_REPO_JSON": '{"org/model": 7}'})
    env = overlay_to_env({})
    assert env["IMAGE_STEPS_BY_REPO_JSON"] == '{"org/model": 7}'


def test_bootstrap_settings_from_env(monkeypatch) -> None:
    monkeypatch.setenv("IMAGE_STEPS_BY_REPO_JSON", '{"x/y": 11}')
    monkeypatch.delenv("DEFAULT_HF_IMAGE_REPO_ID", raising=False)
    bootstrap_settings_from_env()
    patch_settings_object(settings)
    assert "11" in settings.image_steps_by_repo_json
