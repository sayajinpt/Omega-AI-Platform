from app.config import settings
from app.services.runtime_credentials import apply_credentials, patch_settings_object


def test_apply_credentials_sets_image_steps_json() -> None:
    apply_credentials(
        {
            "IMAGE_STEPS_BY_REPO_JSON": '{"cutycat2000x/InterDiffusion-4.0": 12}',
            "IMAGE_LORA_ADAPTERS_JSON": "[]",
        }
    )
    patch_settings_object(settings)
    assert "InterDiffusion" in settings.image_steps_by_repo_json
    assert "12" in settings.image_steps_by_repo_json
