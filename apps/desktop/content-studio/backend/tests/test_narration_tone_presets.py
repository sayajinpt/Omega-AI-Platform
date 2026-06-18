"""Narration-tone presets — well-formed, retrievable by key, reverse-lookupable by text."""

from __future__ import annotations

import pytest

from app.services.narration_tone_presets import (
    AUTO_FROM_ARCHETYPE,
    NARRATION_TONE_PRESETS,
    NarrationTonePreset,
    compose_full_narration_instruct,
    preset_by_key,
    preset_for_instruct,
    voice_style_for_persist,
)


def test_auto_preset_is_first_and_has_empty_instruct() -> None:
    """The 'Auto from archetype' preset must come first so the dropdown defaults to it,
    and its instruct must be empty so picking it clears the narration_tone field."""
    assert NARRATION_TONE_PRESETS[0] is AUTO_FROM_ARCHETYPE
    assert AUTO_FROM_ARCHETYPE.instruct == ""
    assert AUTO_FROM_ARCHETYPE.key == "auto"


def test_presets_have_unique_keys_and_labels() -> None:
    keys = [p.key for p in NARRATION_TONE_PRESETS]
    labels = [p.label for p in NARRATION_TONE_PRESETS]
    assert len(set(keys)) == len(keys), f"duplicate preset keys: {keys}"
    assert len(set(labels)) == len(labels), f"duplicate preset labels: {labels}"


def test_every_non_auto_preset_has_substantive_instruct() -> None:
    """Each non-Auto preset must carry a real instruction (≥ 40 chars) so picking it
    actually changes Qwen's behavior, plus a one-line description for the UI tooltip."""
    for p in NARRATION_TONE_PRESETS:
        if p.key == AUTO_FROM_ARCHETYPE.key:
            continue
        assert len(p.instruct) >= 40, f"preset {p.key} has too-short instruct: {p.instruct!r}"
        assert p.description.strip(), f"preset {p.key} is missing a description"


def test_pacing_consistency_clause_present_in_every_non_auto_preset() -> None:
    """Every preset that controls speed/energy must include a 'consistent across scenes' note —
    otherwise picking a fast preset still risks the voice drifting slower at the end."""
    consistency_markers = ("consistent", "do not slow down", "maintain", "stable", "keep")
    for p in NARRATION_TONE_PRESETS:
        if p.key == AUTO_FROM_ARCHETYPE.key:
            continue
        low = p.instruct.lower()
        assert any(m in low for m in consistency_markers), (
            f"preset {p.key} lacks a pacing-consistency clause; got: {p.instruct!r}"
        )


@pytest.mark.parametrize(
    "key",
    [p.key for p in NARRATION_TONE_PRESETS],
)
def test_preset_by_key_round_trips_every_preset(key: str) -> None:
    got = preset_by_key(key)
    assert got is not None
    assert got.key == key


def test_preset_by_key_ignores_case_and_whitespace() -> None:
    assert preset_by_key("  AUTO  ") is AUTO_FROM_ARCHETYPE
    assert preset_by_key("Shorts_Punchy") == preset_by_key("shorts_punchy")


def test_preset_by_key_returns_none_for_unknown() -> None:
    assert preset_by_key("totally-made-up") is None
    assert preset_by_key("") is None
    assert preset_by_key(None) is None  # type: ignore[arg-type]


def test_preset_for_instruct_empty_returns_auto() -> None:
    """Blank narration_tone → the 'Auto from archetype' preset highlights in the UI on load."""
    assert preset_for_instruct(None) is AUTO_FROM_ARCHETYPE
    assert preset_for_instruct("") is AUTO_FROM_ARCHETYPE
    assert preset_for_instruct("   ") is AUTO_FROM_ARCHETYPE


def test_preset_for_instruct_matches_verbatim() -> None:
    documentary = preset_by_key("documentary_voiceover")
    assert documentary is not None
    matched = preset_for_instruct(documentary.instruct)
    assert matched is documentary


def test_preset_for_instruct_returns_none_for_hand_edited_text() -> None:
    """Hand-typed tones should fall back to 'Custom' (None) in the UI."""
    assert preset_for_instruct("Speak like a pirate") is None


def test_preset_dataclass_is_frozen() -> None:
    p = NARRATION_TONE_PRESETS[1]
    with pytest.raises((AttributeError, Exception)):
        p.label = "renamed"  # type: ignore[misc]


def test_shorts_preset_exists_and_carries_fast_and_high_energy_keywords() -> None:
    """'Fast & punchy (Shorts / TikTok)' is the obvious choice for short-form — must exist
    AND read as fast / high-energy so users picking it get what they expect."""
    p = preset_by_key("shorts_punchy")
    assert p is not None
    assert "fast" in p.instruct.lower()
    assert "high-energy" in p.instruct.lower() or "urgent" in p.instruct.lower()


def test_asmr_preset_exists_and_is_slow() -> None:
    p = preset_by_key("asmr_bedtime")
    assert p is not None
    assert "slow" in p.instruct.lower() or "calm" in p.instruct.lower()


def test_podcast_theories_preset_exists_and_frames_ethics() -> None:
    p = preset_by_key("podcast_theories_conspiracies")
    assert p is not None
    low = p.instruct.lower()
    assert "podcast" in low or "theor" in low
    assert "ethical" in low or "speculation" in low


def test_populist_left_provocateur_preset_targets_systems_not_groups() -> None:
    """Left-wing provocateur preset must steer toward corporate/oligarch framings AND carry
    an explicit no-hate guardrail (so it can't be used to attack protected groups)."""
    p = preset_by_key("populist_left_provocateur")
    assert p is not None
    low = p.instruct.lower()
    assert any(t in low for t in ("corporate", "billionaire", "oligarch", "capital"))
    # System-not-people framing + no-hate guardrail
    assert "protected group" in low or "ethnicit" in low
    assert "no calls to harm" in low or "no incitement" in low or "doxxing" in low


def test_satirical_dark_humor_preset_is_deadpan_with_guardrails() -> None:
    """Satirical preset must steer toward dry/deadpan irony AND carry no-hate / punch-up guardrails."""
    p = preset_by_key("satirical_dark_humor")
    assert p is not None
    low = p.instruct.lower()
    assert "deadpan" in low or "dry" in low or "irony" in low or "satir" in low
    # Punch-up framing + no-hate guardrail.
    assert "punch up" in low or "punch up at" in low
    assert "protected group" in low or "stereotype" in low
    assert "no calls to harm" in low or "slurs" in low or "doxxing" in low


def test_populist_right_provocateur_preset_targets_systems_not_groups() -> None:
    """Right-wing provocateur preset must steer toward establishment/elite framings AND carry
    an explicit no-hate guardrail (so it can't be used to attack protected groups)."""
    p = preset_by_key("populist_right_provocateur")
    assert p is not None
    low = p.instruct.lower()
    assert any(t in low for t in ("globalist", "deep state", "establishment", "media gatekeeper"))
    assert "protected group" in low or "ethnicit" in low
    assert "no calls to harm" in low or "no incitement" in low or "doxxing" in low


def test_compose_full_narration_instruct_appends_dimension_lines() -> None:
    doc = preset_by_key("documentary_voiceover")
    assert doc is not None
    text = compose_full_narration_instruct({"main": "documentary_voiceover", "emotion": "warm"})
    assert doc.instruct in text
    assert "Emotion:" in text


def test_voice_style_for_persist_returns_none_for_all_auto() -> None:
    assert voice_style_for_persist({"main": "auto", "emotion": "auto"}) is None
    assert voice_style_for_persist(None) is None


def test_preset_for_instruct_strips_voice_controls_appendix() -> None:
    doc = preset_by_key("documentary_voiceover")
    assert doc is not None
    full = compose_full_narration_instruct({"main": "documentary_voiceover", "emotion": "warm"})
    assert preset_for_instruct(full) is doc


def test_preset_uses_named_dataclass_for_typing() -> None:
    """Locks in the field names callers depend on (key/label/description/instruct)."""
    assert NarrationTonePreset.__dataclass_fields__.keys() == {
        "key",
        "label",
        "description",
        "instruct",
    }
