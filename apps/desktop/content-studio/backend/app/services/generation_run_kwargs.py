"""
Merge capability probe, catalog overlay, briefing, and user pins into render kwargs.

Phase 3: pipeline reads these dicts instead of hardcoding per-model parameters.
"""

from __future__ import annotations

from typing import Any

from app.services.generation_capabilities import probe_generation_capabilities

_SPEED_INSTRUCT: dict[str, str] = {
    "very_slow": (
        "Speed: very slow, deliberate — each word earns its place. Pacing must stay consistent "
        "across the whole video."
    ),
    "slow": (
        "Speed: slightly slower than conversational for clarity. Pacing must stay consistent "
        "across the whole video."
    ),
    "fast": (
        "Speed: fast, brisk — keep articulation crisp. Pacing must stay consistent across the "
        "whole video."
    ),
    "very_fast": (
        "Speed: very fast, high-information density — still intelligible. Pacing must stay "
        "consistent across the whole video."
    ),
}


def _control_default(probe: dict[str, Any], control_id: str, fallback: Any) -> Any:
    for ctrl in probe.get("controls") or []:
        if not isinstance(ctrl, dict):
            continue
        if str(ctrl.get("id") or "") == control_id and "default" in ctrl:
            return ctrl["default"]
    return fallback


def _constraint(probe: dict[str, Any], key: str, fallback: Any) -> Any:
    constraints = probe.get("constraints")
    if isinstance(constraints, dict) and key in constraints:
        return constraints[key]
    return fallback


def _probe_defaults(probe: dict[str, Any]) -> dict[str, Any]:
    raw = probe.get("defaults")
    return dict(raw) if isinstance(raw, dict) else {}


def _catalog_overlay(probe: dict[str, Any]) -> dict[str, Any]:
    raw = probe.get("catalog_overlay")
    return dict(raw) if isinstance(raw, dict) else {}


def _narration_speed_from_brief(brief_json: dict[str, Any] | None) -> str | None:
    if not isinstance(brief_json, dict):
        return None
    for key in ("narration_speed", "speech_speed", "tts_speed"):
        val = brief_json.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip().lower()
    return None


def apply_narration_speed_to_instruct(
    instruct: str | None, speed: str | None
) -> str | None:
    if not speed or speed in ("normal", "auto"):
        return instruct
    suffix = _SPEED_INSTRUCT.get(speed)
    if not suffix:
        return instruct
    if instruct and instruct.strip():
        return instruct.strip() + "\n\n" + suffix
    return suffix


def build_tts_run_kwargs(
    repo_id: str,
    *,
    speaker: str | None = None,
    language: str | None = None,
    instruct: str | None = None,
    voice_gender: str | None = None,
    brief_json: dict[str, Any] | None = None,
    user_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Probe pinned TTS repo and merge briefing / project fields into synthesis kwargs.

    Returns ``backend_supported``, ``family``, ``engine``, and normalized TTS fields.
    """
    rid = (repo_id or "").strip()
    probe = probe_generation_capabilities("tts", rid) if rid else {}
    overlay = _catalog_overlay(probe)
    overrides = dict(user_overrides or {})

    sp = (overrides.get("speaker") or speaker or _control_default(probe, "speaker", "Ryan") or "Ryan")
    sp = str(sp).strip() or "Ryan"
    lang = (
        overrides.get("language")
        or language
        or _control_default(probe, "language", "English")
        or "English"
    )
    lang = str(lang).strip() or "English"
    vg = str(
        overrides.get("voice_gender")
        or voice_gender
        or _control_default(probe, "voice_gender", "any")
        or "any"
    ).strip() or "any"

    speed = (
        str(overrides.get("narration_speed") or "").strip().lower()
        or _narration_speed_from_brief(brief_json)
    )
    eff_instruct = instruct
    if overrides.get("instruct") is not None:
        eff_instruct = str(overrides.get("instruct") or "").strip() or None
    eff_instruct = apply_narration_speed_to_instruct(eff_instruct, speed)

    generation_mode = overlay.get("generation_mode") or probe.get("generation_mode")

    return {
        "hf_tts_repo_id": rid,
        "family": probe.get("family"),
        "engine": probe.get("engine"),
        "backend_supported": bool(probe.get("backend_supported")),
        "unsupported_reason": probe.get("unsupported_reason"),
        "generation_mode": generation_mode,
        "speaker": sp,
        "language": lang,
        "instruct": eff_instruct,
        "voice_gender": vg,
        "narration_speed": speed,
        "probe": probe,
    }


def build_image_run_kwargs(
    repo_id: str,
    *,
    image_style: str | None = None,
    brief_json: dict[str, Any] | None = None,
    user_overrides: dict[str, Any] | None = None,
    steps_override: int | None = None,
) -> dict[str, Any]:
    """Probe pinned image repo and merge style + settings into diffusion kwargs."""
    rid = (repo_id or "").strip()
    probe = probe_generation_capabilities("image", rid) if rid else {}
    defaults = _probe_defaults(probe)
    overlay = _catalog_overlay(probe)
    overrides = dict(user_overrides or {})

    style = (
        str(overrides.get("style_preset") or image_style or _control_default(probe, "style_preset", "auto") or "auto")
        .strip()
        .lower()
        or "auto"
    )

    num_steps = int(
        overrides.get("num_inference_steps")
        or steps_override
        or defaults.get("num_inference_steps")
        or _control_default(probe, "num_inference_steps", 8)
        or 8
    )
    guidance = float(
        overrides.get("guidance_scale")
        or defaults.get("guidance_scale")
        or _control_default(probe, "guidance_scale", 7.0)
        or 7.0
    )
    if _constraint(probe, "guidance_scale_fixed", None) is not None:
        guidance = float(_constraint(probe, "guidance_scale_fixed", guidance))

    supports_neg = bool(_constraint(probe, "supports_negative_prompt", True))

    width = int(overrides.get("width") or _control_default(probe, "width", 1024) or 1024)
    height = int(overrides.get("height") or _control_default(probe, "height", 1024) or 1024)

    if isinstance(brief_json, dict):
        aspect = str(brief_json.get("aspect_ratio") or brief_json.get("video_aspect") or "").strip()
        if aspect in ("9:16", "vertical"):
            width, height = min(width, height), max(width, height)
        elif aspect in ("16:9", "horizontal"):
            width, height = max(width, height), min(width, height)

    engine = str(overlay.get("engine") or probe.get("engine") or "diffusers_auto")

    return {
        "hf_image_repo_id": rid,
        "family": probe.get("family"),
        "engine": engine,
        "backend_supported": bool(probe.get("backend_supported")),
        "unsupported_reason": probe.get("unsupported_reason"),
        "image_style": style if style != "auto" else None,
        "style_preset": style,
        "num_inference_steps": max(1, num_steps),
        "guidance_scale": guidance,
        "supports_negative_prompt": supports_neg,
        "width": width,
        "height": height,
        "probe": probe,
    }
