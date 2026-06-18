"""Compact script prompts for chat / local-model paths."""

from app.models.enums import VideoType
from app.models.tables import VideoProject
from app.services.script_llm import compose_script_llm_prompts, script_json_spec
from app.services.video_brief import build_video_brief


def _ronaldo_short_brief():
    p = VideoProject(
        id="p-ronaldo",
        user_id="u",
        title="Ronaldo Short",
        theme="youtube short style video about ronaldo",
        max_duration_seconds=20,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=True,
        use_ai_video_title=True,
        narration_tone="energetic and punchy",
        tts_language="en",
    )
    return build_video_brief(p)


def test_compact_prompts_are_much_smaller_than_full() -> None:
    brief = _ronaldo_short_brief()
    full_sys, full_user = compose_script_llm_prompts(brief, compact=False)
    compact_sys, compact_user = compose_script_llm_prompts(brief, compact=True)
    full_len = len(full_sys) + len(full_user)
    compact_len = len(compact_sys) + len(compact_user)
    assert compact_len < full_len * 0.55
    assert "SCENE PLAN" in compact_user
    assert "EXAMPLES" not in compact_sys


def test_compact_user_keeps_narrow_topic_for_broad_theme() -> None:
    p = VideoProject(
        id="p-broad",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    user = build_video_brief(p).llm_script_user_prompt(compact=True)
    assert "NARROW THE TOPIC" in user


def test_compact_json_spec_is_short() -> None:
    assert len(script_json_spec(compact=True)) < len(script_json_spec(compact=False)) * 0.6
