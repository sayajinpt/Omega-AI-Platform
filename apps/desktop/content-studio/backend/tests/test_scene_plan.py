from app.models.enums import VideoType
from app.services.scene_plan import plan_scene_durations


def test_plan_scene_durations_sum_matches_total_long_form() -> None:
    total = 600
    parts = plan_scene_durations(total, VideoType.youtube_long_16_9)
    assert sum(parts) == total
    assert all(12 <= p <= 90 for p in parts)


def test_plan_scene_durations_theory_type_splits() -> None:
    total = 800
    parts = plan_scene_durations(total, VideoType.theory_narrative_engaging)
    assert sum(parts) == total


def test_plan_scene_durations_shorts_smaller_scenes() -> None:
    total = 45
    parts = plan_scene_durations(total, VideoType.youtube_shorts_vertical)
    assert sum(parts) == total
    lo, hi = 3, 18
    assert all(lo <= p <= hi for p in parts)


def test_plan_scene_durations_shorts_are_balanced_not_lopsided() -> None:
    """Old behavior dumped 15s into scene 1 and 3s into the rest. Reject that imbalance."""
    parts = plan_scene_durations(30, VideoType.youtube_shorts_vertical)
    assert sum(parts) == 30
    assert max(parts) - min(parts) <= 1, parts
    assert max(parts) <= 8, parts


def test_plan_scene_durations_short_10s() -> None:
    parts = plan_scene_durations(10, VideoType.youtube_shorts_vertical)
    assert sum(parts) == 10
    assert len(parts) == 3


def test_plan_scene_durations_short_30s_uses_few_scenes() -> None:
    parts = plan_scene_durations(30, VideoType.youtube_shorts_vertical)
    assert 4 <= len(parts) <= 6, parts


def test_plan_scene_durations_balances_long_form_remainder() -> None:
    parts = plan_scene_durations(610, VideoType.youtube_long_16_9)
    assert sum(parts) == 610
    assert max(parts) - min(parts) <= 1
