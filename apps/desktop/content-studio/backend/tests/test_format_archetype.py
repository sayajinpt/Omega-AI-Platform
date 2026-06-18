"""Format archetypes pair (video_type, duration) → narration tone + hook templates + pacing rules."""

from __future__ import annotations

from app.models.enums import VideoType
from app.services.video_type_profile import (
    CINEMATIC_3ACT,
    EPISODIC_CHAPTERS,
    MICRO_NARRATIVE,
    SHORTS_HOOK_DRIVEN,
    STANDARD_MID,
    format_archetype_for,
)


def test_archetype_30s_shorts_is_hook_driven() -> None:
    arch = format_archetype_for(VideoType.youtube_shorts_vertical, 30)
    assert arch.name == "SHORTS_HOOK_DRIVEN"
    assert "hook-driven" in arch.descriptor.lower()
    joined = "\n".join(arch.pacing_rules)
    assert "≤2 seconds" in joined or "<=2 seconds" in joined
    assert "3" in joined and "5 words" in joined
    assert any("disturbing truth" in t.lower() for t in arch.hook_templates)


def test_archetype_short_form_60s_long_format_still_picks_shorts_archetype() -> None:
    """A 60-second 16:9 video should still use the SHORTS archetype — duration drives tone."""
    arch = format_archetype_for(VideoType.youtube_long_16_9, 60)
    assert arch.name == "SHORTS_HOOK_DRIVEN"


def test_archetype_micro_narrative_for_2_minutes() -> None:
    arch = format_archetype_for(VideoType.youtube_shorts_vertical, 120)
    assert arch.name == "MICRO_NARRATIVE"
    assert "mini-doc" in arch.descriptor.lower() or "1–3 minute" in arch.descriptor


def test_archetype_standard_mid_for_8_minutes() -> None:
    arch = format_archetype_for(VideoType.youtube_long_16_9, 8 * 60)
    assert arch.name == "STANDARD_MID"


def test_archetype_cinematic_3act_for_20_minutes() -> None:
    arch = format_archetype_for(VideoType.theory_narrative_engaging, 20 * 60)
    assert arch.name == "CINEMATIC_3ACT"
    assert "3-act" in arch.descriptor.lower() or "three-act" in arch.descriptor.lower()
    joined = "\n".join(arch.pacing_rules)
    assert "repetition" in joined.lower() or "thematic callback" in joined.lower()
    assert any("To understand what happened in" in t for t in arch.hook_templates)


def test_archetype_episodic_for_45_minutes() -> None:
    arch = format_archetype_for(VideoType.theory_narrative_engaging, 45 * 60)
    assert arch.name == "EPISODIC_CHAPTERS"


def test_theory_modulation_adds_curiosity_loop_rule() -> None:
    """theory_narrative_engaging should add a curiosity-loop pacing rule on top of the base archetype."""
    base = CINEMATIC_3ACT
    modulated = format_archetype_for(VideoType.theory_narrative_engaging, 20 * 60)
    assert len(modulated.pacing_rules) > len(base.pacing_rules)
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "curiosity loop" in joined or "specific question" in joined
    assert "speculation" in joined or "settled science" in joined


def test_theory_short_form_uses_alarmist_not_demographer_voice() -> None:
    """30s theory shorts must not inherit long-form 'reports say' debunker modulation."""
    arch = format_archetype_for(VideoType.theory_narrative_engaging, 30)
    assert arch.name == "SHORTS_HOOK_DRIVEN"
    joined = (arch.narration_voice + "\n" + "\n".join(arch.pacing_rules)).lower()
    assert "what if" in joined
    assert "not a demography lesson" in joined or "demography lesson" not in joined
    assert "reports say" not in joined


def test_documentary_modulation_adds_authoritative_voice() -> None:
    modulated = format_archetype_for(VideoType.documentary_voiceover, 20 * 60)
    assert "authoritative" in modulated.narration_voice.lower()
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "third-person" in joined or "third person" in joined


def test_educational_modulation_demands_jargon_definitions() -> None:
    modulated = format_archetype_for(VideoType.educational_explainer, 7 * 60)
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "jargon" in joined
    assert "one main idea per scene" in joined


def test_commentary_modulation_allows_first_person() -> None:
    modulated = format_archetype_for(VideoType.commentary_opinion, 9 * 60)
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "first-person" in joined
    assert "counter-argument" in joined or "anticipate" in joined


def test_custom_modulation_lets_extra_notes_override() -> None:
    modulated = format_archetype_for(VideoType.custom, 5 * 60)
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "extra notes" in joined and "override" in joined


def test_shorts_vertical_modulation_describes_vertical_framing() -> None:
    modulated = format_archetype_for(VideoType.youtube_shorts_vertical, 30)
    joined = "\n".join(modulated.pacing_rules).lower()
    assert "vertical" in joined and ("portrait" in joined or "9:16" in joined)


def test_forbidden_openers_are_not_empty_for_any_archetype() -> None:
    for arch in (
        SHORTS_HOOK_DRIVEN,
        MICRO_NARRATIVE,
        STANDARD_MID,
        CINEMATIC_3ACT,
        EPISODIC_CHAPTERS,
    ):
        assert len(arch.forbidden_openers) >= 3
        assert any("in this video" in fo.lower() for fo in arch.forbidden_openers)


def test_every_archetype_has_examples_and_retention_pattern() -> None:
    for arch in (
        SHORTS_HOOK_DRIVEN,
        MICRO_NARRATIVE,
        STANDARD_MID,
        CINEMATIC_3ACT,
        EPISODIC_CHAPTERS,
    ):
        assert len(arch.examples) >= 1, f"{arch.name} has no examples"
        for ex in arch.examples:
            assert len(ex) >= 50, f"{arch.name} example too short to be useful"
        assert arch.retention_pattern.strip(), f"{arch.name} missing retention_pattern"


def test_shorts_archetype_has_three_concrete_examples_and_7_step_loop() -> None:
    arch = SHORTS_HOOK_DRIVEN
    assert len(arch.examples) >= 3
    joined_examples = "\n".join(arch.examples)
    assert "EXAMPLE A" in joined_examples
    assert "EXAMPLE B" in joined_examples
    assert "EXAMPLE C" in joined_examples
    assert "EXAMPLE D" in joined_examples
    assert "BAD narration" in joined_examples
    assert len(arch.forbidden_registers) >= 5
    assert "HOOK" in joined_examples
    assert "CUTOFF" in joined_examples or "PUNCH" in joined_examples

    pattern = arch.retention_pattern
    for step in ("COLD OPEN", "CONCRETE FACT", "CONTRADICTION", "EVIDENCE", "QUESTION", "EMOTIONAL PUNCH", "ABRUPT CUTOFF"):
        assert step in pattern, f"7-step loop missing step: {step}"


def test_cinematic_example_uses_prologue_motif_callback_concept() -> None:
    arch = CINEMATIC_3ACT
    joined = "\n".join(arch.examples).lower()
    assert "prologue" in joined
    assert "motif" in joined or "callback" in joined
