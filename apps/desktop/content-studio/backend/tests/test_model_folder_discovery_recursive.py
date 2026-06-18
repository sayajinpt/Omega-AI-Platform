"""Recursive search for the directory containing `model_index.json` (handles nested HF layouts)."""

from __future__ import annotations

from pathlib import Path

from app.services.model_folder_discovery import (
    directory_listing_summary,
    find_diffusers_root,
)


def test_find_diffusers_root_top_level(tmp_path: Path) -> None:
    (tmp_path / "model_index.json").write_text("{}", encoding="utf-8")
    assert find_diffusers_root(tmp_path) == tmp_path


def test_find_diffusers_root_one_level_deep(tmp_path: Path) -> None:
    sub = tmp_path / "InterDiffusion-2.5"
    sub.mkdir()
    (sub / "model_index.json").write_text("{}", encoding="utf-8")
    assert find_diffusers_root(tmp_path) == sub


def test_find_diffusers_root_two_levels_deep(tmp_path: Path) -> None:
    sub = tmp_path / "snapshots" / "abc123"
    sub.mkdir(parents=True)
    (sub / "model_index.json").write_text("{}", encoding="utf-8")
    assert find_diffusers_root(tmp_path) == sub


def test_find_diffusers_root_missing_returns_none(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / "weights.safetensors").write_bytes(b"\x00")
    assert find_diffusers_root(tmp_path) is None


def test_find_diffusers_root_skips_blobs_and_refs(tmp_path: Path) -> None:
    """HF cache `blobs/` contains content-addressed blob hashes, not loadable folders."""
    (tmp_path / "blobs").mkdir()
    (tmp_path / "blobs" / "deadbeef").write_text("{}", encoding="utf-8")
    (tmp_path / "refs").mkdir()
    (tmp_path / "refs" / "main").write_text("rev-abc", encoding="utf-8")
    # Real diffusers root nested elsewhere.
    real = tmp_path / "snapshots" / "rev-abc"
    real.mkdir(parents=True)
    (real / "model_index.json").write_text("{}", encoding="utf-8")
    assert find_diffusers_root(tmp_path) == real


def test_directory_listing_summary_renders_files_and_subdirs(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "inside.txt").write_text("x", encoding="utf-8")
    out = directory_listing_summary(tmp_path)
    assert "a.txt" in out
    assert "sub/" in out
    assert "1 entries" in out  # one file inside sub/


def test_directory_listing_summary_truncates(tmp_path: Path) -> None:
    for i in range(40):
        (tmp_path / f"f{i:03d}.bin").write_bytes(b"\x00")
    out = directory_listing_summary(tmp_path, max_entries=5)
    assert "and 35 more" in out


def test_directory_listing_summary_handles_missing(tmp_path: Path) -> None:
    out = directory_listing_summary(tmp_path / "nope")
    assert "not a directory" in out
