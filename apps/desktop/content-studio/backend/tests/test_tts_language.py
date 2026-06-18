from app.services.tts_language import normalize_tts_language


def test_iso_codes_map_to_qwen_language_names() -> None:
    assert normalize_tts_language("en") == "English"
    assert normalize_tts_language("pt") == "Portuguese"
    assert normalize_tts_language("English") == "English"


def test_bilingual_defaults_to_english() -> None:
    assert normalize_tts_language("en+pt bilingual") == "English"
