"""Wheel name selection for install_gpu_extras.py."""

from __future__ import annotations

import platform
import sys
from unittest.mock import MagicMock

import pytest


def _load_module(monkeypatch: pytest.MonkeyPatch, *, system: str, torch_version: str, cuda: str):
    monkeypatch.setattr(platform, "system", lambda: system)
    fake_torch = MagicMock(__version__=torch_version, version=MagicMock(cuda=cuda))
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    import importlib.util
    from pathlib import Path

    script = Path(__file__).resolve().parents[1] / "scripts" / "install_gpu_extras.py"
    spec = importlib.util.spec_from_file_location(f"install_gpu_extras_{system}", script)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_kingbri_wheel_name_windows_cp313_cu128_torch290(monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _load_module(monkeypatch, system="Windows", torch_version="2.9.0+cu128", cuda="12.8")
    name = mod._kingbri_wheel_name("2.9.0", "128")
    assert name == "flash_attn-2.8.3+cu128torch2.9.0cxx11abiFALSE-cp313-cp313-win_amd64.whl"
    first = mod._flash_attn_wheel_candidates()[0][0]
    assert first == name


def test_existing_cuda_torch_rejects_torch212_on_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _load_module(monkeypatch, system="Windows", torch_version="2.12.0+cu130", cuda="13.0")
    assert mod._existing_cuda_torch_ok() is False


def test_windows_cu130_torch211_prefers_ussoewwin_matching_wheel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mod = _load_module(monkeypatch, system="Windows", torch_version="2.11.0+cu130", cuda="13.0")
    names = [n for n, _ in mod._flash_attn_wheel_candidates()]
    expected = mod._ussoewwin_cu130_wheel_name("2.11.0", "2.9.0")
    assert names[0] == expected
    assert mod._wildminder_cu130_wheel_name("2.11.0") in names
    assert not any("torch210" in n or "torch2.10" in n for n in names)
    assert not any("cu128" in n for n in names)


def test_windows_candidates_without_torch_use_pinned_version_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    import importlib.util
    from pathlib import Path

    monkeypatch.setattr(platform, "system", lambda: "Windows")
    script = Path(__file__).resolve().parents[1] / "scripts" / "install_gpu_extras.py"
    spec = importlib.util.spec_from_file_location("install_gpu_extras_fresh", script)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    names = [n for n, _ in mod._flash_attn_wheel_candidates()]
    assert mod._ussoewwin_cu130_wheel_name(mod.PINNED_CUDA_TORCH, "2.9.0") == names[0]
    assert not any("torch210" in n for n in names)


def test_blackwell_uses_ussoewwin_torch211_first(monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _load_module(monkeypatch, system="Windows", torch_version="2.11.0+cu130", cuda="13.0")
    fake_torch = sys.modules["torch"]
    fake_torch.cuda.is_available.return_value = True
    fake_torch.cuda.get_device_capability.return_value = (12, 0)
    names = [n for n, _ in mod._flash_attn_wheel_candidates()]
    assert names[0] == mod._ussoewwin_cu130_wheel_name("2.11.0", "2.9.0")
    assert mod.BLACKWELL_CP313_WHEEL not in names


def test_blackwell_gpu_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _load_module(monkeypatch, system="Windows", torch_version="2.11.0+cu130", cuda="13.0")
    fake_torch = sys.modules["torch"]
    fake_torch.cuda.is_available.return_value = True
    fake_torch.cuda.get_device_capability.return_value = (12, 0)
    assert mod._is_blackwell_gpu() is True


def test_wheel_matches_torch_rejects_cu128_on_cu130() -> None:
    from pathlib import Path
    import importlib.util

    script = Path(__file__).resolve().parents[1] / "scripts" / "install_gpu_extras.py"
    spec = importlib.util.spec_from_file_location("install_gpu_extras_match", script)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    bad = "flash_attn-2.8.3+cu128torch2.9.0cxx11abiFALSE-cp313-cp313-win_amd64.whl"
    good = mod._wildminder_cu130_wheel_name("2.11.0")
    assert not mod._wheel_matches_torch(bad, "2.11.0", "130")
    assert mod._wheel_matches_torch(good, "2.11.0", "130")


def test_mjun_wheel_name_linux_cp313(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    mod = _load_module(monkeypatch, system="Linux", torch_version="2.9.0+cu128", cuda="12.8")
    name = mod._mjun_wheel_name("2.9.0", "128")
    assert name == "flash_attn-2.8.3+cu128torch2.9-cp313-cp313-linux_x86_64.whl"
