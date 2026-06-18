"""Single-file engines pre-fetch their SDXL/SD-base config dependency into a local dir
(no symlinks → no Windows WinError 1314) and pass that path to ``from_single_file``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("localgen")

from app.services import local_pipeline_sd3 as svc  # noqa: E402


def _seed_config_cache(root: Path, repo: str) -> Path:
    """Mimic what ``download_config_only_snapshot`` would produce."""
    safe = repo.replace("/", "__")
    dest = root / "image" / "_config_cache" / safe
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "model_index.json").write_text("{}", encoding="utf-8")
    return dest


def test_ensure_single_file_config_reuses_cached_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second call must NOT re-download — the sentinel `model_index.json` is enough."""
    dest = _seed_config_cache(tmp_path, "stabilityai/stable-diffusion-xl-base-1.0")
    called: list[str] = []

    def boom(*_a: Any, **_kw: Any) -> Any:  # pragma: no cover - tripwire
        called.append("download")
        raise AssertionError("config download must not run when cache already has model_index.json")

    import localgen.downloads as dl

    monkeypatch.setattr(dl, "download_config_only_snapshot", boom)

    path, err = svc._ensure_single_file_config(
        {"config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0"}, tmp_path
    )
    assert err is None
    assert path == dest
    assert called == []


def test_ensure_single_file_config_returns_none_when_not_declared(tmp_path: Path) -> None:
    path, err = svc._ensure_single_file_config({}, tmp_path)
    assert path is None
    assert err is None


def test_ensure_single_file_config_propagates_download_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import localgen.downloads as dl

    def fail(*_a: Any, **_kw: Any) -> Any:
        raise RuntimeError("network is unplugged")

    monkeypatch.setattr(dl, "download_config_only_snapshot", fail)
    path, err = svc._ensure_single_file_config(
        {"config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0"}, tmp_path
    )
    assert path is None
    assert err is not None
    assert "stabilityai/stable-diffusion-xl-base-1.0" in err
    assert "network is unplugged" in err


def test_ensure_single_file_config_runs_download_when_cache_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import localgen.downloads as dl

    captured: dict[str, Any] = {}

    def fake_download(repo_id: str, local_dir: Any, *_a: Any, **_kw: Any) -> Any:
        captured["repo_id"] = repo_id
        captured["local_dir"] = Path(local_dir)
        Path(local_dir).mkdir(parents=True, exist_ok=True)
        (Path(local_dir) / "model_index.json").write_text("{}", encoding="utf-8")
        return Path(local_dir)

    monkeypatch.setattr(dl, "download_config_only_snapshot", fake_download)
    path, err = svc._ensure_single_file_config(
        {"config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0"}, tmp_path
    )
    assert err is None
    assert path is not None
    assert captured["repo_id"] == "stabilityai/stable-diffusion-xl-base-1.0"
    assert captured["local_dir"].name == "stabilityai__stable-diffusion-xl-base-1.0"


def test_single_file_loader_passes_local_config_path_to_from_single_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The backend stuffs the resolved local config dir into `model_info` and the loader
    must forward it as `config=<that path>` so diffusers doesn't try the HF cache."""
    import sys
    import types

    import localgen.engines as eng
    import localgen.gpu_runtime as gpu

    monkeypatch.setattr(eng, "_resolve_torch_dtype", lambda name: name)
    monkeypatch.setattr(gpu, "before_load", lambda *a, **kw: None)
    monkeypatch.setattr(gpu, "after_use", lambda *a, **kw: None)

    seen: dict[str, Any] = {}

    class _FakePipe:
        def to(self, _device: str) -> "_FakePipe":
            return self

    class _FakeSDXL:
        @classmethod
        def from_single_file(cls, path: str, **kwargs: Any) -> Any:
            seen["path"] = path
            seen["config"] = kwargs.get("config")
            return _FakePipe()

    fake_diffusers = types.ModuleType("diffusers")
    fake_diffusers.StableDiffusionXLPipeline = _FakeSDXL  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)

    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "model.safetensors").write_bytes(b"\x00")
    config_dir = tmp_path / "sdxl-config"
    config_dir.mkdir()
    (config_dir / "model_index.json").write_text("{}", encoding="utf-8")

    info = {
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
        "default_dtype": "float16",
        "_single_file_config_path": str(config_dir),
    }
    eng.load_single_file_pipeline(weights, model_info=info, use_gpu=False)
    assert seen["path"].endswith("model.safetensors")
    assert seen["config"] == str(config_dir)


def test_single_file_loader_falls_back_to_repo_id_when_no_local_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the local pre-fetch wasn't done, the loader passes the repo id as `config=` so
    diffusers handles the fetch itself (may fail on Windows without admin — that's the
    branch the backend is *supposed* to avoid by pre-fetching)."""
    import sys
    import types

    import localgen.engines as eng
    import localgen.gpu_runtime as gpu

    monkeypatch.setattr(eng, "_resolve_torch_dtype", lambda name: name)
    monkeypatch.setattr(gpu, "before_load", lambda *a, **kw: None)
    monkeypatch.setattr(gpu, "after_use", lambda *a, **kw: None)

    seen: dict[str, Any] = {}

    class _FakeSDXL:
        @classmethod
        def from_single_file(cls, path: str, **kwargs: Any) -> Any:
            seen["config"] = kwargs.get("config")

            class _P:
                def to(self, _d: str) -> "_P":
                    return self

            return _P()

    fake_diffusers = types.ModuleType("diffusers")
    fake_diffusers.StableDiffusionXLPipeline = _FakeSDXL  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "diffusers", fake_diffusers)

    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "model.safetensors").write_bytes(b"\x00")
    info = {
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
        "default_dtype": "float16",
        "config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
        # no _single_file_config_path
    }
    eng.load_single_file_pipeline(weights, model_info=info, use_gpu=False)
    assert seen["config"] == "stabilityai/stable-diffusion-xl-base-1.0"
