"""`run_local_tts_for_job` must load the Qwen TTS model exactly once per job and re-use
that single instance across every scene. Re-loading per scene is what was causing the
"voice tone changes between scenes" bug — fresh `from_pretrained` calls re-initialize
the custom-voice embedding with slightly different results each time."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("localgen")

from app.services import local_pipeline_media as svc  # noqa: E402


class _NullDB:
    def add(self, *_a: Any, **_kw: Any) -> None: ...
    def commit(self) -> None: ...


def _make_script(n: int) -> dict[str, Any]:
    return {
        "scenes": [
            {"scene_number": i + 1, "duration_seconds": 5, "narration_text": f"line {i + 1}"}
            for i in range(n)
        ]
    }


def _install_fake_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, Any]:
    """Replace the heavy localgen entry points; count load / generate / dispose invocations."""
    counts: dict[str, Any] = {"loads": 0, "generates": [], "disposes": 0}

    class _FakeModel:
        marker = "the-one-and-only"

    def fake_load(model_dir: Path, *, use_gpu: bool, use_flash_attention: bool) -> tuple[Any, str]:
        counts["loads"] += 1
        return _FakeModel(), "FlashAttention 2"

    def fake_generate(
        model: Any,
        text: str,
        out_path: Path,
        *,
        language: str,
        speaker: str,
        instruct: str | None,
        hf_repo_id: str | None = None,
        voice_gender: str | None = None,
    ) -> tuple[Any, int]:
        assert isinstance(model, _FakeModel), "must reuse the same loaded model across scenes"
        counts["generates"].append(
            {
                "text": text,
                "language": language,
                "speaker": speaker,
                "instruct": instruct,
                "voice_gender": voice_gender,
                "id": id(model),
                "hf_repo_id": hf_repo_id,
            }
        )
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        # Minimal valid WAV (44-byte RIFF header + a couple of frames) so the peak-amplitude
        # check doesn't warn. The exact contents don't matter for this test.
        Path(out_path).write_bytes(
            b"RIFF$\x00\x00\x00WAVEfmt "
            b"\x10\x00\x00\x00\x01\x00\x01\x00\x80>\x00\x00\x00}\x00\x00\x02\x00\x10\x00"
            b"data\x00\x00\x00\x00"
        )
        return ([0.0], 16000)

    def fake_dispose(model: Any | None, *, reason: str = "") -> None:
        counts["disposes"] += 1

    import localgen.engines as eng
    import localgen.gpu_runtime as gpu

    monkeypatch.setattr(eng, "load_qwen_tts_model", fake_load)
    monkeypatch.setattr(eng, "generate_qwen_speech", fake_generate)
    monkeypatch.setattr(gpu, "dispose_qwen_tts_model", fake_dispose)

    return counts


def test_tts_loads_model_once_for_a_multi_scene_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(svc, "_resolve_tts_model_dir", lambda pref: (tmp_path / "weights", "pinned (x)"))
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")
    counts = _install_fake_engine(monkeypatch)

    summary = svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=_make_script(5),
        speaker="Ryan",
        language="English",
        instruct="Fast urgent pacing.",
        hf_tts_repo_id="any/repo",
    )

    assert counts["loads"] == 1, "Qwen TTS must be loaded ONCE — not per scene"
    assert len(counts["generates"]) == 5
    assert counts["disposes"] == 1
    # All five scenes used the same model instance — pin via id().
    ids = {c["id"] for c in counts["generates"]}
    assert len(ids) == 1, "every scene must reuse the same loaded model instance"
    assert "5/5" in summary


def test_tts_passes_instruct_through_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(svc, "_resolve_tts_model_dir", lambda pref: (tmp_path / "weights", "pinned (x)"))
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")
    counts = _install_fake_engine(monkeypatch)

    svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=_make_script(3),
        instruct="Speak with fast, urgent energy.",
    )
    instructs = {c["instruct"] for c in counts["generates"]}
    assert instructs == {"Speak with fast, urgent energy."}


def test_tts_forwards_hf_repo_id_to_generate_for_generation_mode_routing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pinned ``hf_tts_repo_id`` must reach ``generate_qwen_speech`` so voice_design vs
    custom_voice routing can work."""
    weights = tmp_path / "tts" / "aiseosae__qwenTTS"
    weights.mkdir(parents=True)
    monkeypatch.setattr(
        svc,
        "_resolve_tts_model_dir",
        lambda pref: (weights, "pinned (aiseosae/qwenTTS)"),
    )
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")
    counts = _install_fake_engine(monkeypatch)

    svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=_make_script(2),
        hf_tts_repo_id="aiseosae/qwenTTS",
    )
    assert all(c["hf_repo_id"] == "aiseosae/qwenTTS" for c in counts["generates"])


def test_tts_uses_default_repo_id_when_not_pinned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When ``hf_tts_repo_id`` is unset, synthesis uses the app default Qwen CustomVoice repo."""
    from localgen.registry import DEFAULT_TTS_REPO_ID

    weights = tmp_path / "tts" / "aiseosae__qwenTTS" / "snapshots" / "abc123"
    weights.mkdir(parents=True)
    monkeypatch.setattr(svc, "_resolve_tts_model_dir", lambda pref: (weights, "discovered"))
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")
    counts = _install_fake_engine(monkeypatch)

    svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=_make_script(1),
        hf_tts_repo_id=None,
    )
    assert counts["generates"][0]["hf_repo_id"] == DEFAULT_TTS_REPO_ID


def test_tts_disposes_model_even_when_a_scene_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(svc, "_resolve_tts_model_dir", lambda pref: (tmp_path / "weights", "pinned (x)"))
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")

    import localgen.engines as eng
    import localgen.gpu_runtime as gpu

    loads = {"count": 0}
    disposes = {"count": 0}

    class _Model:
        pass

    def fake_load(*_a: Any, **_kw: Any) -> tuple[_Model, str]:
        loads["count"] += 1
        return _Model(), "PyTorch SDPA"

    def fake_generate(model: _Model, text: str, out_path: Path, **_kw: Any) -> tuple[Any, int]:
        if "boom" in text:
            raise RuntimeError("synth error")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
        return ([], 16000)

    def fake_dispose(model: Any | None, *, reason: str = "") -> None:
        disposes["count"] += 1

    monkeypatch.setattr(eng, "load_qwen_tts_model", fake_load)
    monkeypatch.setattr(eng, "generate_qwen_speech", fake_generate)
    monkeypatch.setattr(gpu, "dispose_qwen_tts_model", fake_dispose)

    script = {
        "scenes": [
            {"scene_number": 1, "duration_seconds": 5, "narration_text": "ok"},
            {"scene_number": 2, "duration_seconds": 5, "narration_text": "boom"},
            {"scene_number": 3, "duration_seconds": 5, "narration_text": "ok"},
        ]
    }
    summary = svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=script,
    )
    assert loads["count"] == 1
    assert disposes["count"] == 1
    assert "2/3" in summary  # one scene failed, two succeeded


def test_tts_handles_load_failure_with_silent_placeholders(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(svc, "_resolve_tts_model_dir", lambda pref: (tmp_path / "weights", "pinned (x)"))
    monkeypatch.setattr(svc, "_storage_audio_dir", lambda *_a, **_kw: tmp_path / "audio")

    import localgen.engines as eng

    def fake_load(*_a: Any, **_kw: Any) -> Any:
        raise RuntimeError("CUDA OOM at load time")

    monkeypatch.setattr(eng, "load_qwen_tts_model", fake_load)

    summary = svc.run_local_tts_for_job(
        db=_NullDB(),
        job_id="j1",
        project_id="p1",
        script_content=_make_script(2),
    )
    assert "silent" in summary.lower()
    assert (tmp_path / "audio" / "scene_01.wav").is_file()
    assert (tmp_path / "audio" / "scene_02.wav").is_file()
