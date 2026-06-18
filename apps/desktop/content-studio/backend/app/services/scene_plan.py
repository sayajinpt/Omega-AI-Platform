"""Split target duration into scene lengths that fit video-type bounds."""

from __future__ import annotations

from app.models.enums import VideoType
from app.services.video_type_profile import scene_duration_bounds


def recommended_scene_count(total_seconds: int, video_type: VideoType) -> int:
    """
    Choose a scene count that yields **balanced** per-scene budgets for the format.

    Shorts: 4–6 scenes is the sweet spot (≈6 s each at 30 s total). Avoids the old behavior of
    7+ scenes for tiny totals (which then forced one giant 15 s opener and many 3 s slivers).
    """
    if total_seconds <= 0:
        raise ValueError("total_seconds must be positive")
    if video_type == VideoType.youtube_shorts_vertical:
        if total_seconds <= 12:
            n = 3
        elif total_seconds <= 20:
            n = 4
        elif total_seconds <= 35:
            n = 5
        elif total_seconds <= 50:
            n = 6
        else:
            n = max(5, min(9, round(total_seconds / 7)))
    elif video_type in (VideoType.documentary_voiceover, VideoType.educational_explainer):
        n = max(4, min(18, round(total_seconds / 38)))
    elif video_type == VideoType.commentary_opinion:
        n = max(5, min(20, round(total_seconds / 28)))
    elif video_type == VideoType.theory_narrative_engaging:
        n = max(5, min(18, round(total_seconds / 40)))
    elif video_type == VideoType.cinematic_action_sequence:
        if total_seconds <= 30:
            n = 8
        elif total_seconds <= 60:
            n = 12
        elif total_seconds <= 120:
            n = 16
        elif total_seconds <= 300:
            n = max(18, min(30, round(total_seconds / 10)))
        else:
            n = max(20, min(36, round(total_seconds / 12)))
    else:
        n = max(4, min(16, round(total_seconds / 42)))
    return max(1, int(n))


def _feasible(total: int, n: int, lo: int, hi: int) -> bool:
    return n * lo <= total <= n * hi


def _adjust_n(total: int, n: int, lo: int, hi: int) -> int:
    n = max(1, n)
    for _ in range(512):
        if _feasible(total, n, lo, hi):
            return n
        if total < n * lo:
            n -= 1
        elif total > n * hi:
            n += 1
        else:
            break
        if n <= 0:
            break
        n = max(1, n)
    raise ValueError(
        f"Cannot split total={total}s into scenes with bounds [{lo},{hi}]. "
        "Try changing max_duration_seconds or video_type."
    )


def split_total_across_scenes(total_seconds: int, scene_count: int, lo: int, hi: int) -> list[int]:
    """
    Distribute ``total_seconds`` across ``scene_count`` scenes as **evenly as possible**.

    Old behavior round-robin filled scene 1 to its max (``hi``) first, then scene 2, etc., which
    produced lopsided budgets like ``[15, 3, 3, 3, 3, 3]`` for a 30 s Short. That gave the LLM a
    huge opening scene and tiny middle/end beats — bad pacing and easy to skip narration in.

    New behavior: base ``= total // n``, then add +1 second to the first ``r = total % n`` scenes.
    Any over/underflow versus the ``[lo, hi]`` bounds is fixed by moving seconds out of the
    longest scene into the shortest until invariants hold.
    """
    if scene_count <= 0:
        raise ValueError("scene_count must be positive")
    if not _feasible(total_seconds, scene_count, lo, hi):
        raise ValueError("infeasible scene bounds for total duration")

    base, rem = divmod(total_seconds, scene_count)
    amounts = [base + (1 if i < rem else 0) for i in range(scene_count)]

    guard = 0
    while guard < scene_count * (hi + lo) + 1024:
        guard += 1
        min_i = min(range(scene_count), key=lambda i: amounts[i])
        max_i = max(range(scene_count), key=lambda i: amounts[i])
        if amounts[min_i] < lo and amounts[max_i] > lo:
            amounts[min_i] += 1
            amounts[max_i] -= 1
            continue
        if amounts[max_i] > hi and amounts[min_i] < hi:
            amounts[max_i] -= 1
            amounts[min_i] += 1
            continue
        break

    if sum(amounts) != total_seconds or any(p < lo or p > hi for p in amounts):
        raise RuntimeError("could not distribute duration across scenes within bounds")
    return amounts


def plan_scene_durations(total_seconds: int, video_type: VideoType) -> list[int]:
    lo, hi = scene_duration_bounds(video_type)
    n = recommended_scene_count(total_seconds, video_type)
    n = _adjust_n(total_seconds, n, lo, hi)
    return split_total_across_scenes(total_seconds, n, lo, hi)
