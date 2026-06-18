"""Parse Omega UI overrides for video inference steps."""

from __future__ import annotations

from app.services.generation_image_settings import image_size_for_repo, image_steps_for_repo


def video_size_for_repo(
    repo_id: str,
    *,
    size_by_repo_json: str,
    fallback_repo_ids: list[str] | None = None,
) -> tuple[int, int] | None:
    """Return explicit ``(width, height)`` for a T2V repo from Omega Settings."""
    return image_size_for_repo(
        repo_id,
        size_by_repo_json=size_by_repo_json,
        fallback_repo_ids=fallback_repo_ids,
    )

_T2V_FRAME_QUANTUM = 8
T2V_MAX_FRAMES = 257


def frames_for_target_duration(
    duration_sec: float,
    fps: int,
    *,
    min_frames: int = 9,
    max_frames: int = T2V_MAX_FRAMES,
) -> int:
    """Map requested clip length to a valid diffusers T2V frame count (8n+1)."""
    if duration_sec <= 0 or fps <= 0:
        return 0
    raw = int(round(float(duration_sec) * int(fps)))
    raw = max(min_frames, min(raw, max_frames))
    n = max(1, (raw - 1 + (_T2V_FRAME_QUANTUM - 1)) // _T2V_FRAME_QUANTUM)
    frames = n * _T2V_FRAME_QUANTUM + 1
    return min(frames, max_frames)


def video_steps_for_repo(
    repo_id: str,
    *,
    global_override: int,
    steps_by_repo_json: str,
    fallback_repo_ids: list[str] | None = None,
) -> int:
    """Return effective step count for a text-to-video repo (same rules as image overrides)."""
    return image_steps_for_repo(
        repo_id,
        global_override=global_override,
        steps_by_repo_json=steps_by_repo_json,
        fallback_repo_ids=fallback_repo_ids,
    )
