import pytest

from app.models.enums import VideoType
from app.models.tables import VideoProject
from app.services.cursor_script_merge import merge_validated_script


def test_merge_rejects_empty_narration_when_budget_positive() -> None:
    project = VideoProject(
        user_id="u1",
        title="X",
        theme="aliens",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        content_notes=None,
    )
    brief_json = {
        "video_type": "youtube_shorts_vertical",
        "target_duration_seconds": 30,
        "scene_durations_seconds": [10, 10, 10],
    }
    script = {
        "title": "Bad",
        "description": "",
        "scenes": [
            {"narration_text": "", "image_prompt": "img", "text_overlays": []},
        ],
    }
    with pytest.raises(ValueError, match="Invalid script JSON"):
        merge_validated_script(project, brief_json, script)
