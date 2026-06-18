"""Voice-widgets preset wiring — autofills the tone text field, clears for 'Auto',
preserves hand-typed text for 'Custom', and highlights the matching preset on load."""

from __future__ import annotations

from typing import Any

import pytest

pytest.importorskip("PyQt6.QtWidgets")

from PyQt6.QtWidgets import QApplication, QComboBox, QFormLayout, QLineEdit, QWidget

from app.desktop.voice_widgets import (
    CUSTOM_PRESET_KEY,
    add_voice_form_rows,
    populate_tone_preset_combo,
    select_tone_preset_for_text,
)
from app.services.narration_tone_presets import (
    AUTO_FROM_ARCHETYPE,
    NARRATION_TONE_PRESETS,
    VOICE_CONTROLS_SPLIT,
    preset_by_key,
)


@pytest.fixture(scope="module")
def qapp() -> QApplication:
    app = QApplication.instance() or QApplication([])
    return app  # type: ignore[return-value]


def _build_form(qapp: QApplication) -> dict[str, Any]:
    parent = QWidget()
    form = QFormLayout(parent)
    gender = QComboBox()
    lang = QComboBox()
    speaker = QComboBox()
    tone = QLineEdit()
    tone_preset = QComboBox()
    refill, binder = add_voice_form_rows(
        form,
        gender_combo=gender,
        lang_combo=lang,
        speaker_combo=speaker,
        tone_edit=tone,
        tone_preset_combo=tone_preset,
    )
    return {
        "parent": parent,
        "form": form,
        "tone": tone,
        "tone_preset": tone_preset,
        "refill": refill,
        "binder": binder,
    }


def _index_for_key(combo: QComboBox, key: str) -> int:
    for i in range(combo.count()):
        if combo.itemData(i) == key:
            return i
    raise AssertionError(f"preset key not found in combo: {key}")


def test_populate_includes_every_preset_plus_custom(qapp: QApplication) -> None:
    combo = QComboBox()
    populate_tone_preset_combo(combo)
    keys = [combo.itemData(i) for i in range(combo.count())]
    for p in NARRATION_TONE_PRESETS:
        assert p.key in keys, f"preset {p.key} missing from combo"
    assert CUSTOM_PRESET_KEY in keys


def test_first_combo_entry_is_auto_so_default_selection_means_auto(qapp: QApplication) -> None:
    combo = QComboBox()
    populate_tone_preset_combo(combo)
    assert combo.itemData(0) == AUTO_FROM_ARCHETYPE.key


def test_selecting_a_preset_autofills_the_tone_field(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    tone: QLineEdit = bag["tone"]
    combo: QComboBox = bag["tone_preset"]

    documentary = preset_by_key("documentary_voiceover")
    assert documentary is not None
    combo.setCurrentIndex(_index_for_key(combo, "documentary_voiceover"))

    assert tone.text() == documentary.instruct


def test_emotion_dimension_appends_voice_controls_to_instruct(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    tone: QLineEdit = bag["tone"]
    combo: QComboBox = bag["tone_preset"]
    binder = bag["binder"]
    assert binder is not None
    documentary = preset_by_key("documentary_voiceover")
    assert documentary is not None
    combo.setCurrentIndex(_index_for_key(combo, "documentary_voiceover"))
    emo = binder._dim_combos["emotion"]
    emo.setCurrentIndex(_index_for_key(emo, "warm"))
    assert documentary.instruct in tone.text()
    assert VOICE_CONTROLS_SPLIT in tone.text()


def test_select_tone_preset_for_text_matches_when_voice_controls_appended(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    combo: QComboBox = bag["tone_preset"]
    documentary = preset_by_key("documentary_voiceover")
    assert documentary is not None
    full = documentary.instruct + f"{VOICE_CONTROLS_SPLIT} (test):\n• Emotion: warm."
    select_tone_preset_for_text(combo, full)
    assert combo.currentData() == "documentary_voiceover"


def test_selecting_auto_clears_the_tone_field(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    tone: QLineEdit = bag["tone"]
    combo: QComboBox = bag["tone_preset"]

    combo.setCurrentIndex(_index_for_key(combo, "shorts_punchy"))
    assert tone.text() != ""
    combo.setCurrentIndex(_index_for_key(combo, AUTO_FROM_ARCHETYPE.key))
    assert tone.text() == ""


def test_selecting_custom_keeps_hand_typed_text(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    tone: QLineEdit = bag["tone"]
    combo: QComboBox = bag["tone_preset"]

    tone.setText("Speak like a sleepy pirate")
    combo.setCurrentIndex(_index_for_key(combo, CUSTOM_PRESET_KEY))
    assert tone.text() == "Speak like a sleepy pirate"


def test_select_tone_preset_for_text_highlights_matching_preset(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    combo: QComboBox = bag["tone_preset"]
    documentary = preset_by_key("documentary_voiceover")
    assert documentary is not None
    select_tone_preset_for_text(combo, documentary.instruct)
    assert combo.currentData() == "documentary_voiceover"


def test_select_tone_preset_for_text_blank_picks_auto(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    combo: QComboBox = bag["tone_preset"]
    select_tone_preset_for_text(combo, "")
    assert combo.currentData() == AUTO_FROM_ARCHETYPE.key


def test_select_tone_preset_for_text_unknown_picks_custom(qapp: QApplication) -> None:
    bag = _build_form(qapp)
    combo: QComboBox = bag["tone_preset"]
    select_tone_preset_for_text(combo, "Speak like a Klingon poet")
    assert combo.currentData() == CUSTOM_PRESET_KEY


def test_form_works_without_preset_combo(qapp: QApplication) -> None:
    """Callers without the preset combo (older code paths) still get a working form."""
    parent = QWidget()
    form = QFormLayout(parent)
    gender = QComboBox()
    lang = QComboBox()
    speaker = QComboBox()
    tone = QLineEdit()
    refill, binder = add_voice_form_rows(
        form,
        gender_combo=gender,
        lang_combo=lang,
        speaker_combo=speaker,
        tone_edit=tone,
    )
    assert binder is None
    assert callable(refill)
    refill()
    assert speaker.count() >= 1
