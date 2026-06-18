"""`run_sd3_images_for_job` uses per-model defaults from the catalog (steps, guidance, negative-prompt)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("localgen")

from app.services import local_pipeline_sd3 as svc  # noqa: E402


class _NullDB:
    def add(self, *a: Any, **kw: Any) -> None: ...
    def commit(self) -> None: ...


def _make_valid_diffusers_dir(path: Path) -> Path:
    """Create a directory that passes the `model_index.json` pre-flight in `run_sd3_images_for_job`."""
    path.mkdir(parents=True, exist_ok=True)
    (path / "model_index.json").write_text("{}", encoding="utf-8")
    return path


def _make_script(n_scenes: int) -> dict[str, Any]:
    return {
        "scenes": [
            {
                "scene_number": i + 1,
                "duration_seconds": 5,
                "narration_text": f"line {i + 1}",
                "image_prompt": f"a quiet shot for scene {i + 1}",
            }
            for i in range(n_scenes)
        ]
    }


def _install_fake_pipeline(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Patch the heavy localgen entry points so the test runs without GPU / weights."""
    calls: dict[str, Any] = {"loader_engines": [], "generate_kwargs": []}

    def fake_load(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
        calls["loader_engines"].append(
            str(model_info.get("engine") or model_info.get("type") or "").lower()
        )
        return object(), "PyTorch SDPA"

    def fake_generate(
        pipe: Any,
        *,
        prompt: str,
        negative_prompt: str | None,
        width: int,
        height: int,
        num_steps: int,
        guidance_scale: float,
        seed: int,
        out_path: Path,
        supports_negative_prompt: bool = True,
        cancel_check=None,
    ) -> None:
        calls["generate_kwargs"].append(
            {
                "prompt": prompt,
                "negative_prompt": negative_prompt,
                "num_steps": num_steps,
                "guidance_scale": guidance_scale,
                "supports_negative_prompt": supports_negative_prompt,
            }
        )
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_bytes(b"\x89PNG\r\n\x1a\n")

    def fake_dispose(*_a: Any, **_kw: Any) -> None: ...

    import localgen.engines as eng_mod
    import localgen.gpu_runtime as gpu_mod

    monkeypatch.setattr(eng_mod, "load_image_pipeline", fake_load)
    monkeypatch.setattr(eng_mod, "generate_image_file", fake_generate)
    monkeypatch.setattr(gpu_mod, "dispose_sd3_pipeline", fake_dispose)
    return calls


def test_runs_zimage_with_correct_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    weights = _make_valid_diffusers_dir(tmp_path / "zimage_weights")
    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights,
            {
                "id": "Tongyi-MAI/Z-Image-Turbo",
                "engine": "zimage",
                "default_num_steps": 9,
                "default_guidance_scale": 0.0,
                "default_dtype": "bfloat16",
                "supports_negative_prompt": False,
            },
            "pinned (Tongyi-MAI/Z-Image-Turbo)",
        ),
    )
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    calls = _install_fake_pipeline(monkeypatch)

    result = svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(2),
        brief_json={"aspect_ratio": "9:16"},
        skip_sd3=False,
        hf_image_repo_id="Tongyi-MAI/Z-Image-Turbo",
    )

    assert "Z-Image" in result
    assert calls["loader_engines"] == ["zimage"]
    for kw in calls["generate_kwargs"]:
        assert kw["num_steps"] == 9
        assert kw["guidance_scale"] == 0.0
        assert kw["supports_negative_prompt"] is False
        assert kw["negative_prompt"] is None


def test_runs_interdiffusion_with_single_file_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """InterDiffusion-2.5 must run via the single-file SDXL loader, pre-flight must
    look for `model.safetensors` (not `model_index.json`), and the SDXL base-config
    pre-fetch must run with the result forwarded to the loader."""
    weights = tmp_path / "id25"
    weights.mkdir(parents=True)
    (weights / "model.safetensors").write_bytes(b"\x00")

    monkeypatch.setattr(svc, "generation_models_root", lambda: tmp_path)

    # Stand-in for the localgen download — proves the backend pre-fetches the config
    # dependency before invoking the loader.
    cfg_download_calls: list[str] = []

    def fake_cfg_download(repo_id: str, local_dir: Any, *_a: Any, **_kw: Any) -> Any:
        cfg_download_calls.append(repo_id)
        Path(local_dir).mkdir(parents=True, exist_ok=True)
        (Path(local_dir) / "model_index.json").write_text("{}", encoding="utf-8")
        return Path(local_dir)

    import localgen.downloads as dl

    monkeypatch.setattr(dl, "download_config_only_snapshot", fake_cfg_download)

    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights,
            {
                "id": "cutycat2000/InterDiffusion-2.5",
                "engine": "diffusers_single_file",
                "single_file_class": "StableDiffusionXLPipeline",
                "single_file_target": "model.safetensors",
                "config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
                "default_num_steps": 28,
                "default_guidance_scale": 5.0,
                "default_dtype": "float16",
                "supports_negative_prompt": True,
            },
            "pinned (cutycat2000/InterDiffusion-2.5)",
        ),
    )
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")

    # Capture the actual model_info passed to the loader so we can assert the resolved
    # config path was stuffed in.
    captured_model_info: dict[str, Any] = {}

    def fake_load(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
        captured_model_info.update(model_info)
        return object(), "PyTorch SDPA"

    def fake_generate(pipe: Any, *, out_path: Path, **_kw: Any) -> None:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_bytes(b"\x89PNG\r\n\x1a\n")

    import localgen.engines as eng_mod
    import localgen.gpu_runtime as gpu_mod

    monkeypatch.setattr(eng_mod, "load_image_pipeline", fake_load)
    monkeypatch.setattr(eng_mod, "generate_image_file", fake_generate)
    monkeypatch.setattr(gpu_mod, "dispose_sd3_pipeline", lambda *_a, **_kw: None)

    result = svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=False,
        hf_image_repo_id="cutycat2000/InterDiffusion-2.5",
    )

    assert "InterDiffusion-2.5" in result
    assert cfg_download_calls == ["stabilityai/stable-diffusion-xl-base-1.0"]
    assert "_single_file_config_path" in captured_model_info
    cfg_path = Path(captured_model_info["_single_file_config_path"])
    assert cfg_path.is_dir()
    assert cfg_path.name == "stabilityai__stable-diffusion-xl-base-1.0"


def test_runs_sd3_with_sd3_defaults(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    weights = _make_valid_diffusers_dir(tmp_path / "sd3")
    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights,
            {
                "id": "tensorart/stable-diffusion-3.5-medium-turbo",
                "engine": "sd3",
                "type": "checkpoint",
                "default_num_steps": 8,
                "default_guidance_scale": 7.0,
                "default_dtype": "float16",
                "supports_negative_prompt": True,
            },
            "pinned (tensorart/stable-diffusion-3.5-medium-turbo)",
        ),
    )
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")

    # Force a known sd3_num_steps so the SD3-override branch is exercised.
    monkeypatch.setattr(svc.settings, "sd3_num_steps", 8, raising=False)

    calls = _install_fake_pipeline(monkeypatch)

    result = svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=False,
        hf_image_repo_id=None,
    )
    assert "SD3" in result
    assert calls["loader_engines"] == ["sd3"]
    assert calls["generate_kwargs"][0]["num_steps"] == 8
    assert calls["generate_kwargs"][0]["guidance_scale"] == 7.0
    assert calls["generate_kwargs"][0]["supports_negative_prompt"] is True


def test_missing_single_file_checkpoint_writes_placeholders_with_clear_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """For the single-file engine the pre-flight must look for `model.safetensors`
    and log it (NOT `model_index.json`) when the checkpoint is missing."""
    weights_dir = tmp_path / "image" / "cutycat2000__InterDiffusion-2.5"
    weights_dir.mkdir(parents=True)
    (weights_dir / "README.md").write_text("oops", encoding="utf-8")

    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights_dir,
            {
                "id": "cutycat2000/InterDiffusion-2.5",
                "engine": "diffusers_single_file",
                "single_file_class": "StableDiffusionXLPipeline",
                "single_file_target": "model.safetensors",
                "default_num_steps": 28,
                "default_guidance_scale": 5.0,
                "default_dtype": "float16",
                "supports_negative_prompt": True,
            },
            "pinned (cutycat2000/InterDiffusion-2.5)",
        ),
    )
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    monkeypatch.setattr(svc, "generation_models_root", lambda: tmp_path)

    captured: list[tuple[str, str]] = []

    class _CapDB:
        def add(self, entry: Any) -> None:
            captured.append((str(getattr(entry, "level", "")), str(getattr(entry, "message", ""))))

        def commit(self) -> None: ...

    _install_fake_pipeline(monkeypatch)
    import localgen.engines as eng_mod

    def _tripwire(*_a: Any, **_kw: Any) -> Any:
        raise AssertionError("loader must not be called when checkpoint is missing")

    monkeypatch.setattr(eng_mod, "load_image_pipeline", _tripwire)

    result = svc.run_sd3_images_for_job(
        db=_CapDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "9:16"},
        skip_sd3=False,
        hf_image_repo_id="cutycat2000/InterDiffusion-2.5",
    )

    assert "weights incomplete" in result.lower()
    error_lines = [m for lvl, m in captured if lvl == "error"]
    assert any("missing `model.safetensors`" in m for m in error_lines)
    assert all("model_index.json" not in m for m in error_lines)


def test_missing_model_index_json_writes_placeholders_with_clear_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the resolved load path has no model_index.json, the loader must NOT be called
    and the job log must show the directory listing + a re-download hint."""
    weights_dir = tmp_path / "image" / "cutycat2000__InterDiffusion-2.5"
    weights_dir.mkdir(parents=True)
    (weights_dir / "README.md").write_text("oops", encoding="utf-8")

    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights_dir,
            {
                "id": "cutycat2000/InterDiffusion-2.5",
                "engine": "diffusers_auto",
                "default_num_steps": 28,
                "default_guidance_scale": 5.0,
                "default_dtype": "bfloat16",
                "supports_negative_prompt": True,
            },
            "pinned (cutycat2000/InterDiffusion-2.5)",
        ),
    )
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    monkeypatch.setattr(svc, "generation_models_root", lambda: tmp_path)

    captured: list[tuple[str, str]] = []

    class _CapDB:
        def add(self, entry: Any) -> None:
            lvl = getattr(entry, "level", "")
            msg = getattr(entry, "message", "")
            captured.append((str(lvl), str(msg)))

        def commit(self) -> None: ...

    calls = _install_fake_pipeline(monkeypatch)
    # Loader MUST NOT be called when model_index.json is missing — replace it with a tripwire.
    import localgen.engines as eng_mod

    def _tripwire(*_a: Any, **_kw: Any) -> Any:
        raise AssertionError("loader must not be called when model_index.json is missing")

    monkeypatch.setattr(eng_mod, "load_image_pipeline", _tripwire)

    result = svc.run_sd3_images_for_job(
        db=_CapDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(2),
        brief_json={"aspect_ratio": "9:16"},
        skip_sd3=False,
        hf_image_repo_id="cutycat2000/InterDiffusion-2.5",
    )

    assert "weights incomplete" in result.lower()
    assert calls["loader_engines"] == []  # loader was never called
    assert (tmp_path / "out" / "scene_01.png").is_file()
    assert (tmp_path / "out" / "scene_02.png").is_file()

    error_lines = [m for lvl, m in captured if lvl == "error"]
    assert any("missing `model_index.json`" in m for m in error_lines)
    assert any("cutycat2000/InterDiffusion-2.5" in m for m in error_lines)
    assert any("README.md" in m for m in error_lines)


def test_nested_diffusers_root_is_resolved_for_zimage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the HF download places `model_index.json` in a nested subdirectory the
    loader's resolved load path must point at that subdirectory, not the bare base."""
    base = tmp_path / "image" / "Tongyi-MAI__Z-Image-Turbo"
    nested = base / "snapshots" / "abc123"
    nested.mkdir(parents=True)
    (nested / "model_index.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(svc, "generation_models_root", lambda: tmp_path)
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")

    # Stub catalog lookup so the engine type drives _refine_load_path.
    monkeypatch.setattr(
        svc,
        "_catalog_entry_for_repo",
        lambda rid, pack_dir=None: {
            "id": "Tongyi-MAI/Z-Image-Turbo",
            "engine": "zimage",
            "default_num_steps": 9,
            "default_guidance_scale": 0.0,
            "default_dtype": "bfloat16",
            "supports_negative_prompt": False,
        },
    )

    calls = _install_fake_pipeline(monkeypatch)
    import localgen.engines as eng_mod

    captured_dir: dict[str, Path] = {}

    def fake_load(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
        captured_dir["dir"] = model_dir
        calls["loader_engines"].append("zimage")
        return object(), "PyTorch SDPA"

    monkeypatch.setattr(eng_mod, "load_image_pipeline", fake_load)

    result = svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "9:16"},
        skip_sd3=False,
        hf_image_repo_id="Tongyi-MAI/Z-Image-Turbo",
    )
    assert "Z-Image" in result
    assert captured_dir["dir"] == nested


def _stub_zimage_resolver(monkeypatch: pytest.MonkeyPatch, weights_dir: Path) -> None:
    monkeypatch.setattr(
        svc,
        "_resolve_sd3_model_dir_and_info",
        lambda preferred_repo_id=None: (
            weights_dir,
            {
                "id": "Tongyi-MAI/Z-Image-Turbo",
                "engine": "zimage",
                "default_num_steps": 9,
                "default_guidance_scale": 0.0,
                "default_dtype": "bfloat16",
                "supports_negative_prompt": False,
            },
            "pinned (Tongyi-MAI/Z-Image-Turbo)",
        ),
    )


def test_image_style_ghibli_prepends_prompt_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A non-Auto style preset must steer every scene's image prompt via prompt_prefix."""
    weights = _make_valid_diffusers_dir(tmp_path / "w")
    _stub_zimage_resolver(monkeypatch, weights)
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    calls = _install_fake_pipeline(monkeypatch)

    svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(2),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=False,
        hf_image_repo_id="Tongyi-MAI/Z-Image-Turbo",
        image_style="ghibli",
    )

    assert len(calls["generate_kwargs"]) == 2
    for kw in calls["generate_kwargs"]:
        assert "ghibli" in kw["prompt"].lower()
        assert "scene" in kw["prompt"].lower()


def test_image_style_auto_does_not_modify_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Auto / unknown style → no prefix; raw image_prompt drives the look."""
    weights = _make_valid_diffusers_dir(tmp_path / "w")
    _stub_zimage_resolver(monkeypatch, weights)
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    calls = _install_fake_pipeline(monkeypatch)

    svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=False,
        hf_image_repo_id="Tongyi-MAI/Z-Image-Turbo",
        image_style="auto",
    )
    assert calls["generate_kwargs"][0]["prompt"] == "a quiet shot for scene 1"


def test_image_style_unknown_key_falls_back_to_no_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unknown style keys must NOT raise — they degrade to the no-steering Auto behavior."""
    weights = _make_valid_diffusers_dir(tmp_path / "w")
    _stub_zimage_resolver(monkeypatch, weights)
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    calls = _install_fake_pipeline(monkeypatch)

    svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(1),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=False,
        hf_image_repo_id="Tongyi-MAI/Z-Image-Turbo",
        image_style="invented-key-that-does-not-exist",
    )
    assert calls["generate_kwargs"][0]["prompt"] == "a quiet shot for scene 1"


def test_skip_sd3_writes_placeholders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(svc, "_storage_images_dir", lambda *_a, **_kw: tmp_path / "out")
    result = svc.run_sd3_images_for_job(
        db=_NullDB(),
        job_id="job1",
        project_id="proj1",
        script_content=_make_script(2),
        brief_json={"aspect_ratio": "16:9"},
        skip_sd3=True,
        hf_image_repo_id=None,
    )
    assert "placeholders" in result.lower()
    assert (tmp_path / "out" / "scene_01.png").is_file()
    assert (tmp_path / "out" / "scene_02.png").is_file()
