"""Validate Cursor-returned script JSON against the planned scene duration budget."""

from __future__ import annotations

from typing import Any

from app.models import VideoProject

_NARR_KEYS = (
    "narration_text",
    "narrationText",
    "narration",
    "voiceover",
    "voice_over",
    "spoken_text",
    "spokenText",
    "script",
    "dialogue",
    "tts_text",
    "ttsText",
)
_IMAGE_KEYS = (
    "image_prompt",
    "imagePrompt",
    "visual_prompt",
    "visualPrompt",
    "image_description",
    "imageDescription",
    "visual_description",
    "visualDescription",
    "visual",
    "scene_visual",
    "sceneVisual",
)


def _first_nonempty_field(row: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        if key not in row:
            continue
        val = row[key]
        if val is None:
            continue
        if isinstance(val, str):
            s = val.strip()
            if s:
                return s
        elif isinstance(val, (int, float)) and not isinstance(val, bool):
            return str(val)
    return ""


def _raw_scene_dicts(script: dict[str, Any]) -> list[Any]:
    for key in ("scenes", "Scenes", "segments", "shots", "sections", "timeline"):
        v = script.get(key)
        if isinstance(v, list):
            return v
    return []


def merge_validated_script(
    project: VideoProject,
    brief_json: dict,
    script: dict[str, Any],
    *,
    orchestrator: str = "cursor_sdk",
) -> dict[str, Any]:
    """
    Merge model script JSON into the planned scene budget.

    Models often return too many/few scenes or wrong ``duration_seconds``. We **normalize**
    to ``len(scene_durations_seconds)`` by truncating or padding, and always use the planned
    duration per index (ignore wrong values from the model).
    """
    expected = [int(x) for x in brief_json["scene_durations_seconds"]]
    raw_scenes = _raw_scene_dicts(script)

    out_scenes: list[dict[str, Any]] = []
    for i, exp_dur in enumerate(expected):
        s = raw_scenes[i] if i < len(raw_scenes) and isinstance(raw_scenes[i], dict) else {}
        overlays = s.get("text_overlays")
        if overlays is None:
            overlays = []
        if not isinstance(overlays, list):
            raise ValueError(f"scene {i + 1}: text_overlays must be a list")
        narr = _first_nonempty_field(s, _NARR_KEYS)
        if not narr:
            narr = str(s.get("narration_text") or "").strip()
        img = _first_nonempty_field(s, _IMAGE_KEYS)
        if not img:
            img = str(s.get("image_prompt") or "").strip()
        out_scenes.append(
            {
                "scene_number": i + 1,
                "duration_seconds": exp_dur,
                "narration_text": narr,
                "image_prompt": img,
                "transition": str(s.get("transition", "fade")),
                "text_overlays": overlays,
            }
        )

    validation_errors: list[str] = []
    for i, row in enumerate(out_scenes):
        dur = int(row["duration_seconds"])
        if dur <= 0:
            continue
        narr = str(row.get("narration_text") or "").strip()
        img = str(row.get("image_prompt") or "").strip()
        vt = str(brief_json.get("video_type") or "")
        action_montage = vt == "cinematic_action_sequence"
        if not narr and not action_montage:
            validation_errors.append(
                f"scene {i + 1} ({dur}s): narration_text is empty — add full spoken lines for TTS"
            )
        if not img:
            validation_errors.append(
                f"scene {i + 1} ({dur}s): image_prompt is empty — add a concrete visual description"
            )

    if validation_errors:
        raise ValueError(
            "Invalid script JSON — fix ALL issues below in one corrected response:\n"
            + "\n".join(f"- {e}" for e in validation_errors)
        )

    title = str(script.get("title") or project.title)
    description = str(script.get("description") or "")

    meta = {
        "theme": project.theme,
        "video_type": brief_json["video_type"],
        "target_duration_seconds": brief_json["target_duration_seconds"],
        "planned_total_seconds": sum(expected),
        "content_notes": project.content_notes,
        "include_subtitles": getattr(project, "include_subtitles", False),
        "use_ai_video_title": getattr(project, "use_ai_video_title", True),
        "episode_topic": getattr(project, "episode_topic", None),
        "orchestrator": orchestrator,
    }

    return {"title": title, "description": description, "meta": meta, "scenes": out_scenes}


def outline_content_only(project: VideoProject, brief_json: dict) -> dict[str, Any]:
    scenes: list[dict[str, Any]] = []
    for i, seconds in enumerate(brief_json["scene_durations_seconds"]):
        scenes.append(
            {
                "scene_number": i + 1,
                "duration_seconds": int(seconds),
                "narration_text": "",
                "image_prompt": "",
                "transition": "fade",
                "text_overlays": [],
            }
        )
    return {
        "title": project.title,
        "description": "",
        "meta": {
            "theme": project.theme,
            "video_type": brief_json["video_type"],
            "target_duration_seconds": brief_json["target_duration_seconds"],
            "planned_total_seconds": sum(int(x) for x in brief_json["scene_durations_seconds"]),
            "content_notes": project.content_notes,
            "include_subtitles": getattr(project, "include_subtitles", False),
            "use_ai_video_title": getattr(project, "use_ai_video_title", True),
            "episode_topic": getattr(project, "episode_topic", None),
            "orchestrator": "outline_stub",
        },
        "scenes": scenes,
    }
