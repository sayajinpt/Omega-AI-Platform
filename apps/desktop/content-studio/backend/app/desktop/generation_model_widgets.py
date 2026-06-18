"""Hugging Face repo pickers for local TTS / SD3 weights (project & series defaults)."""

from __future__ import annotations

from PyQt6.QtWidgets import QComboBox


def populate_hf_repo_combo(combo: QComboBox, kind: str) -> None:
    """Fill combo with app default + catalog/manifest/folder entries for ``tts`` or ``image``."""
    combo.clear()
    try:
        from localgen.installed_models import list_available_models
        from localgen.paths import get_models_root
        from localgen.registry import DEFAULT_IMAGE_REPO_ID, DEFAULT_TTS_REPO_ID

        default_id = DEFAULT_TTS_REPO_ID if kind == "tts" else DEFAULT_IMAGE_REPO_ID
        default_label = (
            "Default — Qwen3-TTS 0.6B CustomVoice"
            if kind == "tts"
            else "Default — InterDiffusion Nano"
        )
        combo.addItem(default_label, default_id)

        root = get_models_root()
        for repo_id, label, on_disk in list_available_models(root, kind):  # type: ignore[arg-type]
            if repo_id == default_id:
                continue
            suffix = "" if on_disk else " — not downloaded yet"
            combo.addItem(f"{label}{suffix}", repo_id)
    except Exception:
        from localgen.registry import DEFAULT_IMAGE_REPO_ID, DEFAULT_TTS_REPO_ID

        default_id = DEFAULT_TTS_REPO_ID if kind == "tts" else DEFAULT_IMAGE_REPO_ID
        combo.addItem("Default model", default_id)


def select_hf_repo_combo(combo: QComboBox, repo_id: str | None, *, kind: str = "tts") -> None:
    from app.services.generation_defaults import effective_image_repo_id, effective_tts_repo_id

    rid = effective_tts_repo_id(repo_id) if kind == "tts" else effective_image_repo_id(repo_id)
    for i in range(combo.count()):
        if combo.itemData(i) == rid:
            combo.setCurrentIndex(i)
            return
    combo.setCurrentIndex(0)


def populate_image_style_combo(combo: QComboBox) -> None:
    """Fill combo with all art-style presets from ``STYLE_PRESETS``.

    Item ``data`` is the stored key (``"ghibli"``, ``"anime"``, …); index 0 is the
    no-steering ``"auto"`` entry. Falls back to a single Auto item if the localgen
    package isn't importable (e.g. very stripped CI image).
    """
    combo.clear()
    try:
        from localgen.registry import STYLE_PRESETS

        for label, entry in STYLE_PRESETS.items():
            key = str(entry.get("key") or label).strip().lower()
            desc = str(entry.get("description") or "")
            combo.addItem(label, key)
            if desc:
                combo.setItemData(combo.count() - 1, desc, 3)  # Qt.ItemDataRole.ToolTipRole
    except Exception:
        combo.addItem("Auto", "auto")


def select_image_style_combo(combo: QComboBox, style_key: str | None) -> None:
    """Pick the entry whose stored key matches ``style_key`` (case-insensitive)."""
    key = (style_key or "").strip().lower() or "auto"
    for i in range(combo.count()):
        if str(combo.itemData(i) or "").strip().lower() == key:
            combo.setCurrentIndex(i)
            return
    combo.setCurrentIndex(0)
