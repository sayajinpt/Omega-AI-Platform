"""Map chat briefing + theme text → ``VideoType`` (structure) and ``image_style`` (look)."""

from __future__ import annotations

import re

from app.models.enums import VideoType

# Legacy briefing tokens that conflated structure with diffusion look.
_LEGACY_SHORT_STYLE = frozenset(
    {
        "youtube_short",
        "youtube short",
        "youtube_short vertical fast-paced",
        "youtube short vertical fast-paced",
        "shorts",
        "vertical fast-paced",
    }
)

_ACTION_THEME = re.compile(
    r"\b(chase|chasing|highway|car\s+chase|action\s+scene|action\s+sequence|"
    r"movie\s+style|blockbuster|transformers?|explosion|fight\s+scene|"
    r"montage|storyboard|multi[\s-]?frame|multi[\s-]?shot|"
    r"cinematic\s+action|car\s+crash|pursuit|racing)\b",
    re.I,
)

_SHORT_THEME = re.compile(
    r"\b(youtube\s+short|shorts|tiktok|reels|vertical\s+short|60\s*sec(?:ond)?\s+short)\b",
    re.I,
)

_DOC_THEME = re.compile(
    r"\b(documentary|voiceover|narrator|investigation|archive\s+footage)\b",
    re.I,
)


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def resolve_video_type(
    *,
    theme: str = "",
    video_format: str | None = None,
    image_style: str | None = None,
    max_duration_seconds: int | None = None,
) -> VideoType:
    """
    Pick the structural video type (scene count, pacing, narration density).

    ``video_format`` from briefing wins; else infer from theme; legacy ``image_style`` shorts
    tokens still map to Shorts when no explicit format was chosen.
    """
    fmt = _norm(video_format)
    if fmt:
        aliases = {
            "youtube_shorts_vertical": VideoType.youtube_shorts_vertical,
            "youtube_short": VideoType.youtube_shorts_vertical,
            "shorts": VideoType.youtube_shorts_vertical,
            "short": VideoType.youtube_shorts_vertical,
            "cinematic_action_sequence": VideoType.cinematic_action_sequence,
            "cinematic_action": VideoType.cinematic_action_sequence,
            "action_montage": VideoType.cinematic_action_sequence,
            "movie_sequence": VideoType.cinematic_action_sequence,
            "chase_scene": VideoType.cinematic_action_sequence,
            "documentary_voiceover": VideoType.documentary_voiceover,
            "documentary": VideoType.documentary_voiceover,
            "educational_explainer": VideoType.educational_explainer,
            "explainer": VideoType.educational_explainer,
            "commentary_opinion": VideoType.commentary_opinion,
            "theory_narrative_engaging": VideoType.theory_narrative_engaging,
            "youtube_long_16_9": VideoType.youtube_long_16_9,
            "long_form": VideoType.youtube_long_16_9,
            "custom": VideoType.custom,
        }
        for key, vt in aliases.items():
            if fmt == key or fmt.replace(" ", "_") == key or fmt.replace("-", "_") == key:
                return vt
        try:
            return VideoType(fmt)
        except ValueError:
            pass

    combined = f"{theme}\n{image_style or ''}"
    if _ACTION_THEME.search(combined):
        return VideoType.cinematic_action_sequence
    if _SHORT_THEME.search(combined):
        return VideoType.youtube_shorts_vertical
    if _DOC_THEME.search(combined):
        return VideoType.documentary_voiceover

    istyle = _norm(image_style)
    if istyle in _LEGACY_SHORT_STYLE or "youtube_short" in istyle or "vertical fast" in istyle:
        return VideoType.youtube_shorts_vertical

    dur = int(max_duration_seconds or 0)
    if dur and dur <= 120:
        return VideoType.youtube_shorts_vertical
    return VideoType.youtube_long_16_9


def normalize_image_style(
    raw: str | None,
    *,
    video_type: VideoType,
) -> str | None:
    """
    Map briefing free-text to a ``STYLE_PRESETS`` key, or pass through known keys.

    Structural tokens (``youtube_short …``) are not image presets — return a sensible look
    default for the chosen format instead.
    """
    s = _norm(raw)
    if not s or s in ("auto", "default"):
        if video_type == VideoType.cinematic_action_sequence:
            return "cinematic_film"
        if video_type == VideoType.youtube_shorts_vertical:
            return "digital_art"
        return None

    if s in _LEGACY_SHORT_STYLE or s.startswith("youtube_short") or "vertical fast" in s:
        return "digital_art"

    alias = {
        "cinematic food photography": "studio_photo",
        "clean minimal modern": "digital_art",
        "vibrant colorful high contrast": "digital_art",
        "cinematic": "cinematic_film",
        "photorealistic": "photorealistic",
        "anime": "anime",
        "pixar": "pixar_3d",
    }
    if s in alias:
        return alias[s]
    if s.replace(" ", "_") in alias.values():
        return s.replace(" ", "_")
    return s.replace(" ", "_")[:64] or None
