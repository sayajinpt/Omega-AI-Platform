"""Voice / language controls shared by New Project and Project page dialogs."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QSignalBlocker, Qt
from PyQt6.QtWidgets import QComboBox, QFormLayout, QLineEdit

from app.services.narration_tone_presets import (
    NARRATION_TONE_PRESETS,
    VOICE_STYLE_DIMENSIONS,
    VOICE_STYLE_DIM_ORDER,
    compose_full_narration_instruct,
    default_voice_style_dict,
    merge_custom_base_with_style,
    normalize_voice_style_dict,
    preset_for_instruct,
)


def load_voice_registry() -> tuple[dict[str, dict[str, str]], list[str]]:
    try:
        from localgen.registry import SPEAKERS, SUPPORTED_LANGUAGES

        langs = [x for x in SUPPORTED_LANGUAGES if x != "Auto"]
        return SPEAKERS, langs if langs else list(SUPPORTED_LANGUAGES)
    except ImportError:
        return {"Ryan": {"gender": "Male", "language": "English", "description": ""}}, ["English"]


def speakers_for_gender(speakers: dict[str, dict[str, str]], gender: str) -> list[str]:
    g = (gender or "any").strip().lower()
    if g == "any":
        return sorted(speakers.keys())
    out: list[str] = []
    for name, meta in speakers.items():
        mg = (meta.get("gender") or "").lower()
        if g == "female" and "female" in mg:
            out.append(name)
        elif g == "male" and "male" in mg:
            out.append(name)
    return sorted(out) if out else sorted(speakers.keys())


def select_combo_by_data(combo: QComboBox, value: str | None) -> None:
    if not value:
        return
    for i in range(combo.count()):
        if combo.itemData(i) == value:
            combo.setCurrentIndex(i)
            return


CUSTOM_PRESET_KEY = "__custom__"


def populate_tone_preset_combo(combo: QComboBox) -> None:
    """
    Fill ``combo`` with the narration-tone presets + a 'Custom…' sentinel.

    Each item's ``itemData`` is the preset key (or ``CUSTOM_PRESET_KEY``); the tooltip is the
    preset description. The caller wires ``currentIndexChanged`` to populate the tone text
    field with the preset's ``instruct`` string.
    """
    combo.clear()
    for p in NARRATION_TONE_PRESETS:
        combo.addItem(p.label, p.key)
        idx = combo.count() - 1
        if p.description:
            combo.setItemData(idx, p.description, role=int(Qt.ItemDataRole.ToolTipRole))
    combo.addItem("Custom — keep my hand-typed instruct", CUSTOM_PRESET_KEY)
    combo.setItemData(
        combo.count() - 1,
        (
            "Keeps whatever text you typed in the field below — selected automatically when "
            "your tone doesn't match any preset on load."
        ),
        role=int(Qt.ItemDataRole.ToolTipRole),
    )


def populate_voice_dimension_combo(combo: QComboBox, dim_key: str, *, label_prefix: str = "") -> None:
    """Fill a combo with one dimension's :data:`VOICE_STYLE_DIMENSIONS` options."""
    opts = VOICE_STYLE_DIMENSIONS.get(dim_key)
    if not opts:
        return
    combo.clear()
    titles = {
        "emotion": "Emotion",
        "speed": "Speaking speed",
        "pitch": "Pitch register",
        "accent": "Accent / region",
        "delivery": "Delivery / register",
    }
    for o in opts:
        lab = f"{label_prefix}{titles.get(dim_key, dim_key)}: {o.label}"
        combo.addItem(lab, o.key)
        idx = combo.count() - 1
        if o.bullet:
            combo.setItemData(idx, o.bullet, role=int(Qt.ItemDataRole.ToolTipRole))


def select_tone_preset_for_text(combo: QComboBox, tone_text: str | None) -> None:
    """
    Choose the preset whose ``instruct`` matches ``tone_text`` exactly (highlights it in the
    combo on form load). Empty text → 'Auto from archetype'. No match → 'Custom…'.
    """
    matched = preset_for_instruct(tone_text)
    target_key = matched.key if matched is not None else CUSTOM_PRESET_KEY
    for i in range(combo.count()):
        if combo.itemData(i) == target_key:
            combo.setCurrentIndex(i)
            return


class TtsVoiceStyleBinder:
    """
    Wires main narration preset + dimension combos to the free-form ``narration_tone`` field.

    Persists dimension state via :meth:`style_dict` / :meth:`apply_style_dict` (stored in
    ``tts_voice_style`` JSON on the project / series row).
    """

    def __init__(
        self,
        *,
        preset_combo: QComboBox,
        tone_edit: QLineEdit,
        dim_combos: dict[str, QComboBox],
    ) -> None:
        self._preset_combo = preset_combo
        self._tone_edit = tone_edit
        self._dim_combos = dim_combos

    def style_dict(self) -> dict[str, str]:
        d = default_voice_style_dict()
        d["main"] = str(self._preset_combo.currentData() or "auto").lower()
        if d["main"] == CUSTOM_PRESET_KEY:
            d["main"] = "custom"
        for k in VOICE_STYLE_DIM_ORDER:
            c = self._dim_combos.get(k)
            if c is not None:
                d[k] = str(c.currentData() or "auto").lower()
        return d

    def apply_style_dict(self, raw: dict[str, Any] | None) -> None:
        """
        Restore dimension combos from JSON.

        When ``raw`` is ``None``, only dimensions reset to ``auto`` — the main preset combo is
        left unchanged (call :func:`select_tone_preset_for_text` after loading ``narration_tone``).
        """
        if raw is None:
            st = default_voice_style_dict()
            update_main = False
        else:
            st = normalize_voice_style_dict(raw)
            update_main = True
        if update_main:
            with QSignalBlocker(self._preset_combo):
                mk = st.get("main", "auto")
                if mk == "custom":
                    select_combo_by_data(self._preset_combo, CUSTOM_PRESET_KEY)
                else:
                    select_combo_by_data(self._preset_combo, mk)
        for dim in VOICE_STYLE_DIM_ORDER:
            c = self._dim_combos.get(dim)
            if c is not None:
                with QSignalBlocker(c):
                    select_combo_by_data(c, st.get(dim, "auto"))

    def recompose(self) -> None:
        """Rebuild ``tone_edit`` from preset + dimensions (Custom mode merges the control block)."""
        main = str(self._preset_combo.currentData() or "auto")
        if main == CUSTOM_PRESET_KEY:
            self._tone_edit.setText(merge_custom_base_with_style(self._tone_edit.text(), self.style_dict()))
            return
        text = compose_full_narration_instruct(self.style_dict())
        self._tone_edit.setText(text)


def add_voice_form_rows(
    form: QFormLayout,
    *,
    gender_combo: QComboBox,
    lang_combo: QComboBox,
    speaker_combo: QComboBox,
    tone_edit: QLineEdit,
    label_prefix: str = "",
    tone_preset_combo: QComboBox | None = None,
) -> tuple[Callable[[], None], TtsVoiceStyleBinder | None]:
    """
    Adds labeled rows and returns ``(refill_speakers, voice_style_binder)``.

    ``label_prefix`` e.g. ``"Default "`` for series defaults. When ``tone_preset_combo`` is
    set, dimension preset rows are added and a :class:`TtsVoiceStyleBinder` keeps the tone
    field in sync; otherwise the second return value is ``None``.
    """
    SPEAKERS, LANGS = load_voice_registry()
    for lg in LANGS:
        lang_combo.addItem(lg, lg)
    for label, val in [("Any", "any"), ("Male", "male"), ("Female", "female")]:
        gender_combo.addItem(label, val)

    def refill() -> None:
        speaker_combo.clear()
        g = str(gender_combo.currentData() or "any")
        for name in speakers_for_gender(SPEAKERS, g):
            speaker_combo.addItem(name, name)

    refill()
    gender_combo.currentIndexChanged.connect(lambda _i: refill())

    lp = label_prefix
    form.addRow(f"{lp}Narration language", lang_combo)
    form.addRow(f"{lp}Voice gender filter", gender_combo)
    form.addRow(f"{lp}Voice / speaker", speaker_combo)

    binder: TtsVoiceStyleBinder | None = None
    dim_combos: dict[str, QComboBox] = {}

    if tone_preset_combo is not None:
        populate_tone_preset_combo(tone_preset_combo)
        select_tone_preset_for_text(tone_preset_combo, tone_edit.text())
        form.addRow(f"{lp}Narration tone preset", tone_preset_combo)

        for dim in VOICE_STYLE_DIM_ORDER:
            c = QComboBox()
            populate_voice_dimension_combo(c, dim, label_prefix=lp)
            dim_combos[dim] = c
            titles = {
                "emotion": "Emotion",
                "speed": "Speed",
                "pitch": "Pitch",
                "accent": "Accent",
                "delivery": "Delivery",
            }
            form.addRow(f"{lp}TTS — {titles[dim]}", c)

        binder = TtsVoiceStyleBinder(preset_combo=tone_preset_combo, tone_edit=tone_edit, dim_combos=dim_combos)

        def _on_preset_changed(_idx: int) -> None:
            if tone_preset_combo.currentData() == CUSTOM_PRESET_KEY:
                return
            binder.recompose()

        def _on_dim_changed(_idx: int) -> None:
            binder.recompose()

        tone_preset_combo.currentIndexChanged.connect(_on_preset_changed)
        for c in dim_combos.values():
            c.currentIndexChanged.connect(_on_dim_changed)

    form.addRow(f"{lp}Narration tone (free-form, optional)", tone_edit)
    tone_edit.setPlaceholderText(
        "Leave blank for archetype default, pick presets above, or type your own. "
        "Emotion / speed / accent rows append a Voice controls block to the instruct."
    )

    return refill, binder
