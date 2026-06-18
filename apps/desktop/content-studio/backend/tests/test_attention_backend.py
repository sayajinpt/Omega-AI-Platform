"""Attention backend policy (flash-first, graceful fallback)."""

from __future__ import annotations

import sys
import warnings
from pathlib import Path
from typing import Any

import pytest

_gen = Path(__file__).resolve().parents[2] / "generation_models"
if _gen.is_dir() and str(_gen) not in sys.path:
    sys.path.insert(0, str(_gen))

pytest.importorskip("localgen")

from localgen import attention_backend as ab  # noqa: E402


def test_standalone_image_load_off_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OMEGA_CS_STANDALONE_IMAGE_LOAD", raising=False)
    assert ab.standalone_image_load_enabled() is False
    monkeypatch.setenv("OMEGA_CS_STANDALONE_IMAGE_LOAD", "1")
    assert ab.standalone_image_load_enabled() is True
    monkeypatch.setenv("OMEGA_CS_STANDALONE_IMAGE_LOAD", "0")
    monkeypatch.setattr(ab, "cuda_available", lambda: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "flash")
    assert ab.should_use_flash_image_attention(use_gpu=True) is True
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: False)
    assert ab.should_use_flash_image_attention(use_gpu=True) is False


def test_pipeline_uses_fast_attention_detects_legacy() -> None:
    class AttnProcessor:
        pass

    class AttnProcessor2_0:
        pass

    class FakeUNet:
        attn_processors = {"a": AttnProcessor(), "b": AttnProcessor2_0()}

    class Pipe:
        unet = FakeUNet()

    assert ab._pipeline_uses_fast_attention(Pipe()) is False  # noqa: SLF001

    class FastUNet:
        attn_processors = {"a": AttnProcessor2_0(), "b": AttnProcessor2_0()}

    class FastPipe:
        unet = FastUNet()

    assert ab._pipeline_uses_fast_attention(FastPipe()) is True  # noqa: SLF001


def test_load_diffusers_pipeline_auto_uses_sdpa_kwarg(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "auto")
    calls: list[str | None] = []

    class FakeUNet:
        attn_processors = {"x": type("AttnProcessor2_0", (), {})()}

    class FakePipe:
        unet = FakeUNet()

    def factory(path: str, *, attn_implementation: str | None = None, **_: Any) -> FakePipe:
        calls.append(attn_implementation)
        return FakePipe()

    monkeypatch.setattr(ab, "_pipeline_uses_fast_attention", lambda _: True)
    obj, label = ab._load_diffusers_pipeline_auto(  # noqa: SLF001
        factory, "/m", use_gpu=True, component="t", model_path=None, torch_dtype=None
    )
    assert isinstance(obj, FakePipe)
    assert calls == ["sdpa"]
    assert "sdpa" in label


def test_gpu_attention_mode_default_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OMEGA_GPU_ATTENTION_MODE", raising=False)
    monkeypatch.delenv("OMEGA_PREFER_FLASH_ATTENTION", raising=False)
    assert ab.gpu_attention_mode() == "auto"


def test_should_prefer_flash_from_omega_settings_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ab, "cuda_available", lambda: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "off")
    assert ab.should_prefer_flash_attention(use_gpu=True) is False
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "auto")
    assert ab.should_prefer_flash_attention(use_gpu=True) is False
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "flash")
    assert ab.should_prefer_flash_attention(use_gpu=True) is True
    monkeypatch.delenv("OMEGA_GPU_ATTENTION_MODE", raising=False)
    monkeypatch.setenv("OMEGA_PREFER_FLASH_ATTENTION", "0")
    assert ab.gpu_attention_mode() == "off"
    monkeypatch.setenv("OMEGA_PREFER_FLASH_ATTENTION", "1")
    assert ab.gpu_attention_mode() == "flash"
    assert ab.should_prefer_flash_attention(use_gpu=True) is True


def test_should_use_flash_attention_for_images_in_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ab, "cuda_available", lambda: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "auto")
    assert ab.should_use_flash_attention_for_images(use_gpu=True) is True
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "off")
    assert ab.should_use_flash_attention_for_images(use_gpu=True) is False
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: False)
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "auto")
    assert ab.should_use_flash_attention_for_images(use_gpu=True) is False


def test_should_prefer_flash_disabled_by_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMEGA_DISABLE_FLASH_ATTENTION", "1")
    monkeypatch.setattr(ab, "cuda_available", lambda: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    assert ab.should_prefer_flash_attention(use_gpu=True) is False


def test_attention_label_variants() -> None:
    assert ab.attention_label(on_cuda=True, used_flash=True, flash_failed=False) == "FlashAttention 2"
    assert "fallback" in ab.attention_label(on_cuda=True, used_flash=False, flash_failed=True)
    assert ab.attention_label(on_cuda=False, used_flash=False, flash_failed=False) == "PyTorch SDPA (CPU)"


def test_load_with_hf_attention_falls_back_on_type_error(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def factory(path: str, *, attn_implementation: str | None = None, **_: Any) -> str:
        calls.append(attn_implementation or "none")
        if attn_implementation == "flash_attention_2":
            raise TypeError("unexpected keyword argument")
        return f"ok:{path}"

    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "flash")
    monkeypatch.setattr(ab, "should_prefer_flash_attention", lambda **_: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    obj, label = ab.load_with_hf_attention(factory, "/m", use_gpu=True, component="test")
    assert obj == "ok:/m"
    assert "flash_attention_2" in calls
    assert "sdpa" in calls
    assert label.startswith("PyTorch SDPA")


def test_attn_implementation_ignored_detected() -> None:
    import warnings

    class W:
        def __init__(self, message: str) -> None:
            self.message = message

    caught = [W("Keyword arguments {'attn_implementation': 'flash_attention_2'} are not expected and will be ignored.")]
    assert ab._attn_implementation_ignored(caught) is True  # noqa: SLF001
    assert ab._attn_implementation_ignored([]) is False


def test_load_with_hf_attention_plain_when_flash_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "off")
    monkeypatch.setattr(ab, "should_prefer_flash_attention", lambda **_: False)
    monkeypatch.setattr(ab, "cuda_available", lambda: False)

    def factory(path: str, **_: Any) -> str:
        return path

    obj, label = ab.load_with_hf_attention(factory, "x", use_gpu=False, component="test")
    assert obj == "x"
    assert label == "PyTorch SDPA (CPU)"


def test_load_with_hf_attention_patches_pipeline_even_without_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Diffusers often logs 'ignored' via logging, not warnings — pipelines must still be patched."""

    class FakeUNet:
        def set_attn_processor(self, _proc: object) -> None:
            pass

    class FakePipe:
        unet = FakeUNet()

    def factory(path: str, *, attn_implementation: str | None = None, **_: Any) -> FakePipe:
        return FakePipe()

    configured: list[str] = []

    def fake_configure(*_a: Any, component: str = "", **_k: Any) -> str:
        configured.append(component)
        return "PyTorch SDPA (AttnProcessor2_0 on unet)"

    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "flash")
    monkeypatch.setattr(ab, "should_prefer_flash_attention", lambda **_: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    monkeypatch.setattr(ab, "configure_diffusers_pipeline_attention", fake_configure)

    obj, label = ab.load_with_hf_attention(factory, "/models/x", use_gpu=True, component="image-diffusers")
    assert isinstance(obj, FakePipe)
    assert configured == ["image-diffusers"]
    assert "AttnProcessor2_0" in label
    assert label != "FlashAttention 2"


def test_load_with_hf_attention_patches_pipeline_when_flash_kwarg_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeUNet:
        def parameters(self):
            return iter([])

        def set_attn_processor(self, _proc: object) -> None:
            pass

        def to(self, device: object) -> FakeUNet:
            return self

    class FakePipe:
        unet = FakeUNet()

    def factory(path: str, *, attn_implementation: str | None = None, **_: Any) -> FakePipe:
        if attn_implementation:
            warnings.warn(
                "Keyword arguments {'attn_implementation': 'flash_attention_2'} "
                "are not expected by StableDiffusionXLPipeline and will be ignored.",
                UserWarning,
            )
        return FakePipe()

    monkeypatch.setenv("OMEGA_GPU_ATTENTION_MODE", "flash")
    monkeypatch.setattr(ab, "should_prefer_flash_attention", lambda **_: True)
    monkeypatch.setattr(ab, "flash_attn_installed", lambda: True)
    monkeypatch.setattr(ab, "_reload_submodule_with_flash", lambda *a, **k: None)
    monkeypatch.setattr(
        ab,
        "configure_diffusers_pipeline_attention",
        lambda *a, **k: "PyTorch SDPA (AttnProcessor2_0 on unet)",
    )

    obj, label = ab.load_with_hf_attention(factory, "/models/x", use_gpu=True, component="test")
    assert isinstance(obj, FakePipe)
    assert "AttnProcessor2_0" in label or "SDPA" in label
    assert label != "FlashAttention 2"
