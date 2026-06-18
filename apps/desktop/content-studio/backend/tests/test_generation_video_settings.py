"""Video steps overrides from Omega Settings JSON."""

from __future__ import annotations

from app.services.generation_video_settings import (
    frames_for_target_duration,
    video_size_for_repo,
    video_steps_for_repo,
)


def test_video_steps_for_repo() -> None:
    raw = '{"Lightricks/LTX-Video-0.9.5": 40}'
    assert (
        video_steps_for_repo("Lightricks/LTX-Video-0.9.5", global_override=0, steps_by_repo_json=raw)
        == 40
    )


def test_video_steps_for_repo_falls_back_to_global() -> None:
    assert video_steps_for_repo("Lightricks/LTX-Video-0.9.5", global_override=25, steps_by_repo_json="") == 25


def test_frames_for_target_duration_ltx_10s() -> None:
    # LTX @ 24 fps: 10s → 241 frames (8n+1, capped at 257)
    assert frames_for_target_duration(10, 24) == 241


def test_frames_for_target_duration_default_catalog() -> None:
    # ~4s default when no duration requested maps to 97 frames @ 24 fps
    assert frames_for_target_duration(4, 24) == 97


def test_frames_for_target_duration_caps_at_model_max() -> None:
    assert frames_for_target_duration(60, 24) == 257


def test_video_size_for_repo_explicit() -> None:
    raw = '{"Lightricks/LTX-Video-0.9.5": {"width": 1280, "height": 720}}'
    assert video_size_for_repo("Lightricks/LTX-Video-0.9.5", size_by_repo_json=raw) == (1280, 720)


def test_video_size_for_repo_zero_means_default() -> None:
    raw = '{"Lightricks/LTX-Video-0.9.5": {"width": 0, "height": 0}}'
    assert video_size_for_repo("Lightricks/LTX-Video-0.9.5", size_by_repo_json=raw) is None
