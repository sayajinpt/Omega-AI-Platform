from app.models.enums import VideoType
from app.models.tables import Series, VideoProject
from app.services.video_brief import build_video_brief


def test_video_brief_includes_duration_aware_pacing() -> None:
    p = VideoProject(
        id="p1",
        user_id="u",
        title="Working",
        theme="Urban legends",
        max_duration_seconds=35,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=True,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert b.target_duration_seconds == 35
    assert "Micro / Shorts-length" in b.pacing_and_structure_notes or "Short vertical" in b.pacing_and_structure_notes
    prompt = b.llm_script_user_prompt()
    assert "Subtitles" in prompt
    assert "text_overlays" in prompt
    assert "# SERIES CONTEXT" not in prompt


def test_video_brief_series_context() -> None:
    s = Series(
        id="s1",
        user_id="u",
        title="Conspiracies",
        theme="Investigate claims with curiosity and ethics.",
        default_max_duration_seconds=1200,
        default_video_type=VideoType.theory_narrative_engaging,
        default_include_subtitles=False,
        topic_dedup_recent_count=40,
    )
    p = VideoProject(
        id="p2",
        user_id="u",
        series_id=s.id,
        series=s,
        title="Episode placeholder",
        theme=s.theme,
        max_duration_seconds=1200,
        video_type=VideoType.theory_narrative_engaging,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert "SERIES NAME: Conspiracies" in b.llm_script_user_prompt()
    assert b.series_topic_dedup_window == 40
    assert "RECENT EPISODES" not in b.llm_script_user_prompt()
    assert "Theory / mystery" in b.pacing_and_structure_notes or "theory" in b.pacing_and_structure_notes.lower()


def test_video_brief_merges_episode_topic_into_theme() -> None:
    p = VideoProject(
        id="p3",
        user_id="u",
        title="Ep",
        theme="Series bible",
        episode_topic="This week: Roswell memos",
        max_duration_seconds=600,
        video_type=VideoType.youtube_long_16_9,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert "Episode-specific focus" in b.theme
    assert "Roswell" in b.theme


def test_short_form_with_broad_theme_demands_one_specific_story() -> None:
    """A 30s short on 'alien conspiracy theories' must include the NARROW-TOPIC instruction."""
    p = VideoProject(
        id="p4",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    user_prompt = b.llm_script_user_prompt()
    assert "NARROW THE TOPIC" in user_prompt
    assert "PICK ONE" in b.llm_script_system_prompt() or "pick ONE" in b.llm_script_user_prompt().lower()
    assert "Roswell" in user_prompt or "GOOD" in user_prompt
    assert "BAD" in user_prompt


def test_short_form_scene_plan_table_in_user_prompt() -> None:
    """User prompt must surface a SCENE PLAN table with roles + per-scene word budgets."""
    p = VideoProject(
        id="p5",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    user_prompt = b.llm_script_user_prompt()
    assert "SCENE PLAN" in user_prompt
    assert "HOOK" in user_prompt
    assert "PAYOFF" in user_prompt
    assert "word budget" in user_prompt.lower()


def test_system_prompt_marks_short_form_format() -> None:
    p = VideoProject(
        id="p6",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    system = b.llm_script_system_prompt()
    assert "SHORT-FORM" in system
    assert "PICK ONE" in system or "Pick ONE" in system or "pick ONE" in system


def test_no_image_mode_changes_prompt_visual_section() -> None:
    """When no_image_mode=True, the prompt must tell the LLM the narration IS the on-screen text."""
    p = VideoProject(
        id="p_noi",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
        no_image_mode=True,
    )
    b = build_video_brief(p)
    assert b.no_image_mode is True
    user_prompt = b.llm_script_user_prompt()
    assert "NO-IMAGE" in user_prompt
    assert "narration_text" in user_prompt
    system = b.llm_script_system_prompt()
    assert "NO-IMAGE" in system


def test_no_image_mode_off_keeps_subtitle_section() -> None:
    p = VideoProject(
        id="p_img",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
        no_image_mode=False,
    )
    b = build_video_brief(p)
    assert b.no_image_mode is False
    assert "NO-IMAGE" not in b.llm_script_user_prompt()
    assert "NO-IMAGE" not in b.llm_script_system_prompt()


def test_long_form_does_not_force_topic_narrow_rule() -> None:
    """An 8-minute long-form video with the same theme should NOT include the 'NARROW THE TOPIC' block."""
    p = VideoProject(
        id="p7",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=8 * 60,
        video_type=VideoType.theory_narrative_engaging,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert "NARROW THE TOPIC" not in b.llm_script_user_prompt()
    assert "LONG-FORM" in b.llm_script_system_prompt()


def test_short_theory_brief_uses_hook_register_not_debunk_essay() -> None:
    """Theory format at 30s must get shorts hook voice, not demography-lesson framing."""
    p = VideoProject(
        id="p_theory_short",
        user_id="u",
        title="Working",
        theme="migrants invasion western societies to population replacement theory",
        max_duration_seconds=30,
        video_type=VideoType.theory_narrative_engaging,
        include_subtitles=True,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    system = b.llm_script_system_prompt()
    assert "SHORT-FORM" in system
    assert "VOICE REGISTER" in system
    assert "demography explainer" in system.lower() or "demography lesson" in system.lower()
    assert "here's what we actually know" in system.lower()


def test_short_brief_renders_shorts_archetype_block() -> None:
    """A 30s shorts video must surface the SHORTS_HOOK_DRIVEN archetype in both prompts."""
    p = VideoProject(
        id="p_arch_short",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=30,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert b.format_archetype.name == "SHORTS_HOOK_DRIVEN"

    system = b.llm_script_system_prompt()
    assert "# NARRATION ARCHETYPE" in system
    assert "SHORTS_HOOK_DRIVEN" in system
    assert "hook-driven" in system.lower()
    assert "Forbidden openers" in system
    assert "In this video" in system
    assert "Hook templates" in system
    assert "disturbing truth" in system.lower()
    assert "VOICE REGISTER" in system
    assert "what if" in system.lower()
    assert "Forbidden register" in system
    assert "census offices" in system.lower()

    user = b.llm_script_user_prompt()
    assert "Narration archetype: SHORTS_HOOK_DRIVEN" in user
    assert "Structural signature:" in user


def test_long_narrative_brief_renders_cinematic_archetype_block() -> None:
    """A 20-min theory video must surface the CINEMATIC_3ACT archetype with 3-act + callback guidance."""
    p = VideoProject(
        id="p_arch_long",
        user_id="u",
        title="Working",
        theme="The disappearance of Flight 19",
        max_duration_seconds=20 * 60,
        video_type=VideoType.theory_narrative_engaging,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    b = build_video_brief(p)
    assert b.format_archetype.name == "CINEMATIC_3ACT"

    system = b.llm_script_system_prompt()
    assert "CINEMATIC_3ACT" in system
    assert "3-act" in system.lower() or "three-act" in system.lower()
    assert "callback" in system.lower() or "repetition" in system.lower()
    assert "To understand what happened in" in system
    assert "curiosity loop" in system.lower() or "specific question" in system.lower()

    user = b.llm_script_user_prompt()
    assert "Narration archetype: CINEMATIC_3ACT" in user


def test_shorts_prompt_includes_worked_examples_and_retention_loop() -> None:
    """A 30s shorts brief must surface concrete examples AND the 7-step retention loop."""
    p = VideoProject(
        id="p_examples_short",
        user_id="u",
        title="Working",
        theme="alien conspiracy theories",
        max_duration_seconds=45,
        video_type=VideoType.youtube_shorts_vertical,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    system = build_video_brief(p).llm_script_system_prompt()

    assert "# RETENTION PATTERN" in system
    assert "COLD OPEN" in system
    assert "CONCRETE FACT" in system
    assert "ABRUPT CUTOFF" in system

    assert "# EXAMPLES — adapt the PATTERN, not the words" in system
    assert "DO NOT copy" in system
    assert "EXAMPLE A" in system
    assert "EXAMPLE B" in system
    assert "[0:00]" in system or "[0:00] " in system


def test_cinematic_prompt_includes_prologue_example() -> None:
    """A 20-min cinematic brief must include the worked prologue example."""
    p = VideoProject(
        id="p_examples_long",
        user_id="u",
        title="Working",
        theme="The recordings nobody can explain",
        max_duration_seconds=20 * 60,
        video_type=VideoType.theory_narrative_engaging,
        include_subtitles=False,
        use_ai_video_title=True,
    )
    system = build_video_brief(p).llm_script_system_prompt()

    assert "# EXAMPLES" in system
    assert "PROLOGUE" in system
    assert "motif" in system.lower() or "callback" in system.lower()
