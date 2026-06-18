from app.models.enums import VideoType
from app.services.scene_plan import plan_scene_durations
from app.services.video_format_resolver import normalize_image_style, resolve_video_type


def test_chase_theme_resolves_action_montage() -> None:
    vt = resolve_video_type(theme="Transformer movie style highway chase scene", max_duration_seconds=300)
    assert vt == VideoType.cinematic_action_sequence


def test_youtube_short_style_legacy_maps_to_shorts_format() -> None:
    vt = resolve_video_type(
        theme="aliens",
        image_style="youtube_short vertical fast-paced",
        max_duration_seconds=45,
    )
    assert vt == VideoType.youtube_shorts_vertical


def test_explicit_video_format_wins() -> None:
    vt = resolve_video_type(
        theme="highway chase",
        video_format="youtube_shorts_vertical",
        max_duration_seconds=300,
    )
    assert vt == VideoType.youtube_shorts_vertical


def test_action_montage_plans_many_scenes_for_five_minutes() -> None:
    parts = plan_scene_durations(300, VideoType.cinematic_action_sequence)
    assert len(parts) >= 18
    assert sum(parts) == 300


def test_normalize_image_style_maps_legacy_short_token() -> None:
    style = normalize_image_style("youtube_short vertical fast-paced", video_type=VideoType.youtube_shorts_vertical)
    assert style == "digital_art"
