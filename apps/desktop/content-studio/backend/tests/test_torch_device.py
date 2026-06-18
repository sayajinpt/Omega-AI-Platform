"""Tests for Content Studio PyTorch device selection (CUDA / DirectML / CPU)."""

from __future__ import annotations

from localgen import torch_device as td


def test_media_accelerators_report_shape(monkeypatch) -> None:
    monkeypatch.setattr(td, "cuda_works", lambda: False)
    monkeypatch.setattr(td, "directml_works", lambda: False)
    report = td.media_accelerators_report()
    assert report["image"]["accelerator"] == "cpu"
    assert report["tts"]["accelerator"] == "cpu"
    assert report["video"]["accelerator"] == "cpu"
    assert "torchVersion" in report


def test_effective_use_gpu_directml(monkeypatch) -> None:
    monkeypatch.setattr(td, "cuda_works", lambda: False)
    monkeypatch.setattr(td, "directml_works", lambda: True)
    assert td.effective_use_gpu(True) is True
    assert td.diffusers_accelerator(want_gpu=True) == "directml"


def test_tts_load_device_map_directml(monkeypatch) -> None:
    monkeypatch.setattr(td, "cuda_works", lambda: False)
    monkeypatch.setattr(td, "directml_works", lambda: True)
    assert td.tts_load_device_map(want_gpu=True) == "cpu"
