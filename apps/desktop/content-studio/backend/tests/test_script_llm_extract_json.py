"""Tests for ``_extract_json_object`` (CLI often appends text after JSON)."""

from __future__ import annotations

import pytest

from app.services.script_llm import _extract_json_object


def test_extract_stops_at_first_object_when_extra_prose_follows() -> None:
    payload = '{"title": "T", "description": "D", "scenes": []}'
    text = payload + "\n\nHope this helps! Let me know if you need edits."
    out = _extract_json_object(text)
    assert out == {"title": "T", "description": "D", "scenes": []}


def test_extract_with_leading_prose() -> None:
    text = (
        'Okay — here is the JSON:\n{"title": "X", "description": "", '
        '"scenes": [{"duration_seconds": 5, "narration_text": "n", '
        '"image_prompt": "i", "transition": "fade", "text_overlays": []}]} trailing'
    )
    out = _extract_json_object(text)
    assert out["title"] == "X"
    assert len(out["scenes"]) == 1


def test_extract_json_fence_still_works() -> None:
    text = """Here you go:
```json
{"title": "F", "description": "", "scenes": []}
```
done."""
    out = _extract_json_object(text)
    assert out["title"] == "F"


def test_extract_prefers_later_object_with_scenes_over_leading_status_blob() -> None:
    """CLI sometimes prints a small JSON status object before the real script."""
    text = (
        '{"session":"ok","done":false}\n'
        '{"title": "Full", "description": "d", "scenes": ['
        '{"duration_seconds": 5, "narration_text": "n1", "image_prompt": "i1", '
        '"transition": "fade", "text_overlays": []}'
        "]}"
    )
    out = _extract_json_object(text)
    assert out["title"] == "Full"
    assert len(out["scenes"]) == 1
    assert out["scenes"][0]["narration_text"] == "n1"


def test_extract_accepts_array_root_with_one_object() -> None:
    text = '[{"title": "Arr", "description": "", "scenes": []}]'
    out = _extract_json_object(text)
    assert out["title"] == "Arr"
    assert out["scenes"] == []


def test_extract_prefers_populated_scenes_when_same_scene_count() -> None:
    """Two script-shaped objects with equal scene counts — prefer the one with real narration."""
    text = (
        '{"title":"empty_first","scenes":['
        '{"duration_seconds":5,"narration_text":"","image_prompt":"","transition":"fade","text_overlays":[]},'
        '{"duration_seconds":5,"narration_text":"","image_prompt":"","transition":"fade","text_overlays":[]}]}'
        "\n"
        '{"title":"filled_second","scenes":['
        '{"duration_seconds":5,"narration_text":"a","image_prompt":"p","transition":"fade","text_overlays":[]},'
        '{"duration_seconds":5,"narration_text":"b","image_prompt":"q","transition":"fade","text_overlays":[]}]}'
    )
    out = _extract_json_object(text)
    assert out["title"] == "filled_second"


def test_extract_unwraps_result_envelope() -> None:
    text = (
        '{"result":{"title":"In","description":"","scenes":['
        '{"duration_seconds":5,"narration_text":"x","image_prompt":"y","transition":"fade","text_overlays":[]}'
        "]}}"
    )
    out = _extract_json_object(text)
    assert out["title"] == "In"
    assert out["scenes"][0]["narration_text"] == "x"


def test_parse_cursor_cli_stdout_json_envelope_with_message_json_string() -> None:
    import json

    from app.services.script_llm import parse_cursor_cli_stdout

    inner = {"title": "E", "description": "", "scenes": []}
    envelope = json.dumps({"type": "completion", "message": json.dumps(inner)})
    out = parse_cursor_cli_stdout(envelope)
    assert out == inner


def test_extract_rejects_plain_array_of_primitives() -> None:
    with pytest.raises(ValueError, match="Could not parse"):
        _extract_json_object("[1,2,3]")