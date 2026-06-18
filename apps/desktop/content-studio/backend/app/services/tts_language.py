"""Map briefing / ISO language codes to Qwen TTS language names."""

from __future__ import annotations

_ALIASES: dict[str, str] = {
    "auto": "Auto",
    "en": "English",
    "english": "English",
    "pt": "Portuguese",
    "portuguese": "Portuguese",
    "pt br": "Portuguese",
    "pt-br": "Portuguese",
    "es": "Spanish",
    "spanish": "Spanish",
    "fr": "French",
    "french": "French",
    "de": "German",
    "german": "German",
    "it": "Italian",
    "italian": "Italian",
    "ja": "Japanese",
    "japanese": "Japanese",
    "ko": "Korean",
    "korean": "Korean",
    "ru": "Russian",
    "russian": "Russian",
    "zh": "Chinese",
    "chinese": "Chinese",
}


def normalize_tts_language(raw: str | None) -> str:
    """
    Qwen custom-voice TTS expects full language names (``English``, ``Portuguese``, …).
    Briefing chips often send ISO codes (``en``, ``pt``) — normalize before synthesis.
    """
    text = (raw or "").strip()
    if not text:
        return "English"
    low = text.lower().replace("_", " ").replace("-", " ")
    if low in _ALIASES:
        return _ALIASES[low]
    if "bilingual" in low or "+" in text:
        parts = [p.strip() for p in low.replace("bilingual", "").split("+") if p.strip()]
        for part in parts:
            if part in ("en", "english") or "english" in part:
                return "English"
            if part in ("pt", "portuguese") or "portuguese" in part:
                return "Portuguese"
        return "English"
    for canonical in _ALIASES.values():
        if canonical.lower() == low:
            return canonical
    return text
