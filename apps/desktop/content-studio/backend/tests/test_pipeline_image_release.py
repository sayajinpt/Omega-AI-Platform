"""Image VRAM must be dropped before TTS loads."""

from unittest.mock import MagicMock, patch

from app.services.pipeline_image_release import release_image_vram_before_tts


def test_release_image_vram_before_tts_disposes_warm_cache_and_unloads() -> None:
    db = MagicMock()
    with (
        patch("app.services.pipeline_job_pipes.dispose_job_image_pipe") as dispose_job,
        patch("app.services.pipeline_warm_cache.clear_warm_image_pipeline") as clear_warm,
        patch("localgen.gpu_runtime.unload_all") as unload,
    ):
        release_image_vram_before_tts(db, "job-abc")
    dispose_job.assert_called_once_with("job-abc")
    clear_warm.assert_called_once()
    unload.assert_called_once()
    assert db.add.called
    db.commit.assert_called_once()
