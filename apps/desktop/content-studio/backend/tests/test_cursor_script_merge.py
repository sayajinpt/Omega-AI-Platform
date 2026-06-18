from app.models.enums import VideoType
from app.services.cursor_script_merge import merge_validated_script
from app.models.tables import VideoProject


def test_merge_validated_script_accepts_cursor_output() -> None:
    project = VideoProject(
        user_id="u1",
        title="Test",
        theme="Ancient Rome engineering",
        max_duration_seconds=120,
        video_type=VideoType.youtube_long_16_9,
        content_notes=None,
    )
    brief_json = {
        "video_type": "youtube_long_16_9",
        "target_duration_seconds": 120,
        "scene_durations_seconds": [60, 60],
    }
    script = {
        "title": "Rome",
        "description": "d",
        "scenes": [
            {"duration_seconds": 60, "narration_text": "a", "image_prompt": "p1", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 60, "narration_text": "b", "image_prompt": "p2", "transition": "cut", "text_overlays": []},
        ],
    }
    out = merge_validated_script(project, brief_json, script)
    assert out["title"] == "Rome"
    assert len(out["scenes"]) == 2
    assert out["scenes"][0]["scene_number"] == 1
    assert out["meta"]["orchestrator"] == "cursor_sdk"


def test_merge_coerces_scene_count_and_budget_durations() -> None:
    project = VideoProject(
        user_id="u1",
        title="Short",
        theme="t",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        content_notes=None,
    )
    brief_json = {
        "video_type": "youtube_shorts_vertical",
        "target_duration_seconds": 30,
        "scene_durations_seconds": [5, 5, 5, 5, 5, 5],
    }
    script = {
        "title": "T",
        "description": "d",
        "scenes": [
            {"duration_seconds": 5, "narration_text": "s1", "image_prompt": "p", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 5, "narration_text": "s2", "image_prompt": "p", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 5, "narration_text": "s3", "image_prompt": "p", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 5, "narration_text": "s4", "image_prompt": "p", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 5, "narration_text": "s5", "image_prompt": "p", "transition": "fade", "text_overlays": []},
            {"duration_seconds": 5, "narration_text": "s6", "image_prompt": "p", "transition": "fade", "text_overlays": []},
        ],
    }
    out = merge_validated_script(project, brief_json, script)
    assert len(out["scenes"]) == 6
    assert [s["duration_seconds"] for s in out["scenes"]] == [5, 5, 5, 5, 5, 5]
    assert out["scenes"][0]["narration_text"] == "s1"
    assert out["scenes"][1]["narration_text"] == "s2"
    assert out["scenes"][5]["narration_text"] == "s6"
