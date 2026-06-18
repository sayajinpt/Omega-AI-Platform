"""Research query builder — intent-aware, not bare keywords."""

from __future__ import annotations

from app.models.enums import VideoType
from app.services.script_research import build_script_research_query
from app.services.video_brief import VideoBrief
from app.services.video_type_profile import aspect_ratio, combined_pacing_notes


def _brief(**kwargs: object) -> VideoBrief:
    merged: dict = dict(
        project_id="p1",
        title="t",
        theme="aliens",
        content_notes=None,
        video_type=VideoType.youtube_shorts_vertical,
        target_duration_seconds=30,
        scene_durations_seconds=[10, 10, 10],
    )
    merged.update(kwargs)
    vt = merged["video_type"]
    td = merged["target_duration_seconds"]
    merged.setdefault("aspect_ratio", aspect_ratio(vt))
    merged["pacing_and_structure_notes"] = combined_pacing_notes(vt, td)
    return VideoBrief(**merged)  # type: ignore[arg-type]


def test_primary_query_includes_format_not_only_theme() -> None:
    b = _brief()
    q = build_script_research_query(b, supplementary=False)
    assert "30" in q or "runtime" in q.lower()
    assert "aliens" in q.lower()
    # Shorts bias toward hook/controversy angles, not encyclopedic nonfiction SERPs.
    assert "viral hook" in q.lower() or "controversy" in q.lower()


def test_supplementary_query_is_documentary_phrased() -> None:
    b = _brief(theme="aliens")
    q = build_script_research_query(b, supplementary=True)
    assert "Hollywood" in q or "movies" in q.lower()
    assert "factual" in q.lower() or "theories" in q.lower()


def test_creator_notes_prioritized_in_primary_query() -> None:
    b = _brief(theme="aliens", content_notes="Focus on the Fermi paradox and recent UAP hearings; no sci-fi films.")
    q = build_script_research_query(b, supplementary=False)
    assert "Fermi" in q or "UAP" in q


def test_primary_query_respects_tavily_400_char_cap() -> None:
    """Tavily rejects queries > 400 chars with HTTP 400. The builder must hard-cap to 400."""
    b = _brief(
        theme="alien conspiracy theories",
        content_notes=("speak about cold-war era abduction reports, declassified docs, " * 30).strip(),
    )
    q = build_script_research_query(b, supplementary=False)
    assert len(q) <= 400, f"primary query length {len(q)} exceeds Tavily's 400-char limit"


def test_supplementary_query_respects_tavily_400_char_cap() -> None:
    b = _brief(
        theme=("alien conspiracy theories " * 30).strip(),
    )
    q = build_script_research_query(b, supplementary=True)
    assert len(q) <= 400


def test_truncation_preserves_theme_at_front() -> None:
    """When truncation kicks in, the THEME (most important context) must remain — only the
    less-important suffix gets dropped. Otherwise the search would return noise."""
    b = _brief(
        theme="The disappearance of Roanoke Colony",
        content_notes=("colonial-era records archaeology DNA " * 50).strip(),
    )
    q = build_script_research_query(b, supplementary=False)
    assert "Roanoke" in q, f"theme dropped after truncation: {q!r}"
    assert len(q) <= 400


def test_short_theme_keeps_franchise_steering_when_possible() -> None:
    """A 1-2 word theme should still get the 'real-world topic, not a film title' nudge."""
    b = _brief(theme="aliens", content_notes=None)
    q = build_script_research_query(b, supplementary=False)
    assert "real-world topic" in q.lower() or "not a film title" in q.lower()
    assert len(q) <= 400
