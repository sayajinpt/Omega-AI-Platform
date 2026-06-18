"""Loader dispatcher + per-engine inference call shape."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("localgen")

from localgen import engines  # noqa: E402


class _FakePipe:
    def __init__(self) -> None:
        self.device = "cpu"
        self.last_kwargs: dict[str, Any] | None = None

    def __call__(self, **kwargs: Any) -> Any:
        self.last_kwargs = kwargs

        class _Img:
            def save(self, path: str) -> None:
                Path(path).write_bytes(b"\x89PNG\r\n\x1a\n")

        return SimpleNamespace(images=[_Img()])


def test_dispatcher_picks_zimage_loader(monkeypatch: pytest.MonkeyPatch) -> None:
    called: dict[str, Any] = {}

    def fake_zimage(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
        called["zimage"] = (model_dir, model_info, use_gpu)
        return _FakePipe(), "PyTorch SDPA"

    def fake_sd3(*args: Any, **kwargs: Any) -> tuple[Any, str]:
        called["sd3"] = (args, kwargs)
        return _FakePipe(), "PyTorch SDPA"

    def fake_generic(*args: Any, **kwargs: Any) -> tuple[Any, str]:
        called["generic"] = (args, kwargs)
        return _FakePipe(), "PyTorch SDPA"

    monkeypatch.setattr(engines, "load_zimage_pipeline", fake_zimage)
    monkeypatch.setattr(engines, "load_sd3_pipeline", fake_sd3)
    monkeypatch.setattr(engines, "load_generic_diffusers_pipeline", fake_generic)

    info = {"id": "Tongyi-MAI/Z-Image-Turbo", "engine": "zimage"}
    pipe, _label = engines.load_image_pipeline(Path("/x"), model_info=info, use_gpu=False)
    assert isinstance(pipe, _FakePipe)
    assert "zimage" in called
    assert "sd3" not in called
    assert "generic" not in called


def test_dispatcher_picks_generic_for_diffusers_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []
    monkeypatch.setattr(
        engines,
        "load_generic_diffusers_pipeline",
        lambda *a, **kw: (called.append("generic"), (_FakePipe(), "PyTorch SDPA"))[1],
    )
    monkeypatch.setattr(engines, "load_zimage_pipeline", lambda *a, **kw: (_ for _ in ()).throw(AssertionError))
    monkeypatch.setattr(engines, "load_sd3_pipeline", lambda *a, **kw: (_ for _ in ()).throw(AssertionError))

    info = {"id": "cutycat2000/InterDiffusion-2.5", "engine": "diffusers_auto"}
    engines.load_image_pipeline(Path("/x"), model_info=info, use_gpu=False)
    assert called == ["generic"]


def test_dispatcher_picks_single_file_for_interdiffusion(monkeypatch: pytest.MonkeyPatch) -> None:
    """InterDiffusion-2.5 ships only `model.safetensors` — must dispatch to the single-file loader."""
    called: list[tuple[str, dict[str, Any]]] = []

    def fake_single_file(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
        called.append(("single_file", dict(model_info)))
        return _FakePipe(), "PyTorch SDPA"

    monkeypatch.setattr(engines, "load_single_file_pipeline", fake_single_file)
    monkeypatch.setattr(engines, "load_zimage_pipeline", lambda *a, **kw: (_ for _ in ()).throw(AssertionError))
    monkeypatch.setattr(engines, "load_sd3_pipeline", lambda *a, **kw: (_ for _ in ()).throw(AssertionError))
    monkeypatch.setattr(engines, "load_generic_diffusers_pipeline", lambda *a, **kw: (_ for _ in ()).throw(AssertionError))

    info = {
        "id": "cutycat2000/InterDiffusion-2.5",
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
    }
    engines.load_image_pipeline(Path("/x"), model_info=info, use_gpu=False)
    assert len(called) == 1
    assert called[0][1]["single_file_class"] == "StableDiffusionXLPipeline"


def test_single_file_loader_finds_checkpoint_at_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`load_single_file_pipeline` resolves the checkpoint, picks the right pipeline class,
    moves to GPU only when CUDA is available, and never falls back to from_pretrained."""
    ckpt = tmp_path / "model.safetensors"
    ckpt.write_bytes(b"\x00" * 1024)

    seen: dict[str, Any] = {}

    class _FakeSDXL:
        @classmethod
        def from_single_file(cls, path: str, **kwargs: Any) -> Any:
            seen["path"] = path
            seen["kwargs"] = kwargs
            return _FakePipe()

        @classmethod
        def from_pretrained(cls, *a: Any, **kw: Any) -> Any:
            raise AssertionError("single-file engine must NOT call from_pretrained")

    class _FakeDiffusersModule:
        StableDiffusionXLPipeline = _FakeSDXL

    monkeypatch.setattr(engines, "_resolve_torch_dtype", lambda name: name)

    import sys
    import types

    fake_diffusers = types.ModuleType("diffusers")
    fake_diffusers.StableDiffusionXLPipeline = _FakeSDXL  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)

    # Stub gpu_runtime hooks so we don't allocate anything.
    import localgen.gpu_runtime as gpu

    monkeypatch.setattr(gpu, "before_load", lambda *a, **kw: None)
    monkeypatch.setattr(gpu, "after_use", lambda *a, **kw: None)

    info = {
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
        "default_dtype": "float16",
    }
    pipe, _label = engines.load_single_file_pipeline(tmp_path, model_info=info, use_gpu=False)
    assert isinstance(pipe, _FakePipe)
    assert seen["path"] == str(ckpt)


def test_single_file_loader_rejects_unknown_pipeline_class(tmp_path: Path) -> None:
    """Catalog typos must not silently fall through into an unsupported class."""
    (tmp_path / "model.safetensors").write_bytes(b"\x00")
    info = {
        "engine": "diffusers_single_file",
        "single_file_class": "TotallyMadeUpPipeline",
        "single_file_target": "model.safetensors",
    }
    with pytest.raises(RuntimeError, match="unsupported pipeline class"):
        engines.load_single_file_pipeline(tmp_path, model_info=info, use_gpu=False)


def test_single_file_loader_reports_missing_checkpoint(tmp_path: Path) -> None:
    info = {
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
    }
    with pytest.raises(FileNotFoundError, match="model.safetensors"):
        engines.load_single_file_pipeline(tmp_path, model_info=info, use_gpu=False)


def test_dispatcher_falls_back_to_sd3_for_legacy_checkpoint_type(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []
    monkeypatch.setattr(
        engines,
        "load_sd3_pipeline",
        lambda *a, **kw: (called.append("sd3"), (_FakePipe(), "PyTorch SDPA"))[1],
    )

    info = {"id": "tensorart/stable-diffusion-3.5-medium-turbo", "type": "checkpoint"}
    engines.load_image_pipeline(Path("/x"), model_info=info, use_gpu=False)
    assert called == ["sd3"]


def test_generate_image_file_omits_negative_prompt_for_zimage(tmp_path: Path) -> None:
    pipe = _FakePipe()
    out = tmp_path / "scene.png"
    engines.generate_image_file(
        pipe,
        prompt="a quiet street at dawn",
        negative_prompt="cartoon, blurry",
        width=512,
        height=512,
        num_steps=9,
        guidance_scale=0.0,
        seed=42,
        out_path=out,
        supports_negative_prompt=False,
    )
    assert out.is_file()
    assert pipe.last_kwargs is not None
    assert "negative_prompt" not in pipe.last_kwargs
    assert pipe.last_kwargs["num_inference_steps"] == 9
    assert pipe.last_kwargs["guidance_scale"] == 0.0


def test_generate_image_file_standalone_parity_matches_gui_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OMEGA_CS_IMAGE_STANDALONE_PARITY", "1")
    monkeypatch.setenv("OMEGA_CS_IMAGE_VRAM_MODE", "all_gpu")
    pipe = _FakePipe()
    pipe.device = "cuda:0"
    out = tmp_path / "scene.png"
    engines.generate_image_file(
        pipe,
        prompt="sunset over lisbon",
        negative_prompt="blur",
        width=512,
        height=512,
        num_steps=8,
        guidance_scale=7.0,
        seed=42,
        out_path=out,
        supports_negative_prompt=True,
    )
    assert out.is_file()
    assert pipe.last_kwargs is not None
    assert pipe.last_kwargs["prompt"] == "sunset over lisbon"
    assert "prompt_embeds" not in pipe.last_kwargs
    assert "callback_on_step_end" not in pipe.last_kwargs
    gen = pipe.last_kwargs.get("generator")
    assert gen is not None


def test_generate_image_file_no_step_callback_by_default(tmp_path: Path) -> None:
    pipe = _FakePipe()
    engines.generate_image_file(
        pipe,
        prompt="p",
        negative_prompt="n",
        width=512,
        height=512,
        num_steps=4,
        guidance_scale=5.0,
        seed=1,
        out_path=tmp_path / "x.png",
        cancel_check=lambda: None,
    )
    assert "callback_on_step_end" not in pipe.last_kwargs


def test_prepare_sdxl_embeds_skipped_all_gpu_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMEGA_CS_IMAGE_VRAM_MODE", "all_gpu")
    monkeypatch.delenv("OMEGA_CS_OFFLOAD_TEXT_ENCODERS", raising=False)

    class _Pipe:
        unet = object()

        def encode_prompt(self, **kwargs: Any) -> tuple[str, str, str, str]:
            return ("pe", "npe", "ppe", "nppe")

    kw = {"prompt": "sunset", "negative_prompt": "blur", "guidance_scale": 7.0}
    out = engines._prepare_sdxl_embeds_call_kwargs(_Pipe(), dict(kw))
    assert out.get("prompt") == "sunset"
    assert "prompt_embeds" not in out


def test_prepare_sdxl_embeds_when_offload_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OMEGA_CS_IMAGE_VRAM_MODE", "offload_encoders")

    class _Pipe:
        unet = object()

        def encode_prompt(self, **kwargs: Any) -> tuple[str, str, str, str]:
            return ("pe", "npe", "ppe", "nppe")

    kw = {"prompt": "sunset", "negative_prompt": "blur", "guidance_scale": 7.0}
    out = engines._prepare_sdxl_embeds_call_kwargs(_Pipe(), dict(kw))
    assert "prompt_embeds" in out


def test_sdxl_embeds_path_uses_unet_device_generator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-encoded SDXL embeds and the Generator must match UNet device (typically CUDA)."""

    def _fake_prepare(pipe: Any, call_kwargs: dict[str, Any]) -> dict[str, Any]:
        import torch

        out = dict(call_kwargs)
        out.pop("prompt", None)
        out.pop("negative_prompt", None)
        out["prompt_embeds"] = torch.zeros(1, device="cpu")
        return out

    import torch

    monkeypatch.setattr(engines, "_prepare_sdxl_embeds_call_kwargs", _fake_prepare)
    monkeypatch.setattr(engines, "_unet_device_for_pipe", lambda _p: torch.device("cuda:0"))
    pipe = _FakePipe()
    pipe.device = "cuda:0"
    out = tmp_path / "scene.png"
    engines.generate_image_file(
        pipe,
        prompt="sunset",
        negative_prompt="blur",
        width=1024,
        height=1024,
        num_steps=8,
        guidance_scale=7.0,
        seed=42,
        out_path=out,
        supports_negative_prompt=True,
    )
    assert pipe.last_kwargs is not None
    gen = pipe.last_kwargs["generator"]
    assert gen is not None
    assert str(gen.device).startswith("cuda")


def test_generate_image_file_includes_negative_prompt_for_sd3(tmp_path: Path) -> None:
    pipe = _FakePipe()
    out = tmp_path / "scene.png"
    engines.generate_image_file(
        pipe,
        prompt="a quiet street at dawn",
        negative_prompt="cartoon, blurry",
        width=512,
        height=512,
        num_steps=8,
        guidance_scale=7.0,
        seed=42,
        out_path=out,
        supports_negative_prompt=True,
    )
    assert out.is_file()
    assert pipe.last_kwargs is not None
    assert pipe.last_kwargs["negative_prompt"] == "cartoon, blurry"


def test_auto_vram_mode_uses_total_not_free_after_load(monkeypatch: pytest.MonkeyPatch) -> None:
    """16 GiB cards must not enable encoder offload just because the pipeline is loaded."""
    monkeypatch.setenv("OMEGA_CS_IMAGE_VRAM_MODE", "auto")

    monkeypatch.setattr(engines, "_cuda_total_mib", lambda device_index=0: 16_302)
    monkeypatch.setattr(engines, "_cuda_free_mib", lambda device_index=0: 2482)
    assert engines._sdxl_text_encoder_offload_enabled() is False

    monkeypatch.setattr(engines, "_cuda_total_mib", lambda device_index=0: 8192)
    monkeypatch.setattr(engines, "_cuda_free_mib", lambda device_index=0: 6000)
    assert engines._sdxl_text_encoder_offload_enabled() is True


def test_standalone_parity_inference_even_when_offload_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OMEGA_CS_IMAGE_STANDALONE_PARITY", "1")
    monkeypatch.setenv("OMEGA_CS_IMAGE_VRAM_MODE", "offload_encoders")
    pipe = _FakePipe()
    out = tmp_path / "scene.png"
    engines.generate_image_file(
        pipe,
        prompt="city",
        negative_prompt=None,
        width=512,
        height=512,
        num_steps=4,
        guidance_scale=5.0,
        seed=1,
        out_path=out,
        supports_negative_prompt=True,
    )
    assert pipe.last_kwargs is not None
    assert pipe.last_kwargs.get("prompt") == "city"
    assert "prompt_embeds" not in pipe.last_kwargs
