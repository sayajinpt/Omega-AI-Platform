from unittest.mock import MagicMock, patch

from app.services.gpu_release import release_generation_gpu


def test_release_generation_gpu_clears_warm_cache_and_unloads() -> None:
    with (
        patch("app.services.pipeline_warm_cache.clear_warm_image_pipeline") as clear,
        patch("localgen.gpu_runtime.unload_all") as unload,
    ):
        msg = release_generation_gpu(reason="test")
    clear.assert_called_once()
    unload.assert_called_once_with(reason="test")
    assert "released" in msg.lower()


def test_release_generation_gpu_reports_vram_when_cuda() -> None:
    mock_torch = MagicMock()
    mock_torch.cuda.is_available.return_value = True
    mock_torch.cuda.mem_get_info.return_value = (8 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024)
    with (
        patch("app.services.pipeline_warm_cache.clear_warm_image_pipeline"),
        patch("localgen.gpu_runtime.unload_all"),
        patch.dict("sys.modules", {"torch": mock_torch}),
    ):
        msg = release_generation_gpu(reason="unit")
    assert "8192" in msg or "MiB" in msg
