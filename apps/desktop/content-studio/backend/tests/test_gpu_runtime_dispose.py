"""`dispose_sd3_pipeline` must NOT call `pipe.to(...)` on the pipeline.

Calling `.to("cpu")` on an fp16 / bf16 pipeline causes diffusers to emit a noisy
"cannot run with cpu device" warning per disposal, with no VRAM benefit over a plain
`del` + `torch.cuda.empty_cache()`.
"""

from __future__ import annotations

from typing import Any

import pytest

pytest.importorskip("localgen")

from localgen import gpu_runtime  # noqa: E402


class _Spy:
    def __init__(self) -> None:
        self.to_calls: list[Any] = []

    def to(self, device: Any) -> "_Spy":  # noqa: ARG002 - signature mimics diffusers
        self.to_calls.append(device)
        return self


def test_dispose_does_not_move_pipe_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """The fix for the fp16 'cannot run with cpu' warning is to NEVER call .to() in disposal."""
    monkeypatch.setattr(gpu_runtime, "_cuda_gc", lambda sync=False: None)
    spy = _Spy()
    gpu_runtime.dispose_sd3_pipeline(spy, reason="unit-test")
    assert spy.to_calls == []


def test_dispose_releases_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    """Even with the .to() move gone, disposal must still mark the GPU slot as idle."""
    monkeypatch.setattr(gpu_runtime, "_cuda_gc", lambda sync=False: None)
    # Seed an active slot so `after_use` has work to do.
    gpu_runtime.before_load("sd3", reason="seed")
    assert gpu_runtime.active_gpu_kind() == "sd3"
    gpu_runtime.dispose_sd3_pipeline(_Spy(), reason="unit-test")
    assert gpu_runtime.active_gpu_kind() == "none"


def test_dispose_handles_none_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Loader-failure path passes ``pipe=None``; disposal must still clear the slot."""
    monkeypatch.setattr(gpu_runtime, "_cuda_gc", lambda sync=False: None)
    gpu_runtime.before_load("sd3", reason="seed")
    gpu_runtime.dispose_sd3_pipeline(None, reason="loader-failed")
    assert gpu_runtime.active_gpu_kind() == "none"
