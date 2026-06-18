"""Optional web research before script LLM (Tavily). Cursor CLI ``agent -p`` cannot browse the web itself."""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from app.config import settings
from app.services.video_brief import VideoBrief
from app.models.enums import VideoType
from app.services.video_type_profile import delivery_label, is_short_form, video_format_summary

logger = logging.getLogger(__name__)

_TAVILY_SEARCH_URL = "https://api.tavily.com/search"

# Tavily rejects any query longer than 400 characters with a 400 Bad Request
# ("Query is too long. Max query length is 400 characters.").
# See https://help.tavily.com/articles/5504684071-optimizing-your-query-parameter
_TAVILY_MAX_QUERY_CHARS = 400

# Short, search-friendly bias. The previous 280-char paragraph alone almost filled the 400-char
# budget; this version is ~80 chars and leaves room for the actual theme.
_NONFICTION_BIAS = (
    "Credible nonfiction sources only — no fan wikis, franchise pages, or cast lists."
)


def _parse_exclude_domains(raw: str) -> list[str]:
    parts = [p.strip().lower() for p in (raw or "").split(",")]
    return [p for p in parts if p and "." in p][:150]


def _truncate_query(q: str) -> str:
    """Collapse whitespace and hard-cap to Tavily's documented 400-char limit (with ellipsis if cut)."""
    out = re.sub(r"\s+", " ", q).strip()
    if len(out) <= _TAVILY_MAX_QUERY_CHARS:
        return out
    cut = out[: _TAVILY_MAX_QUERY_CHARS - 1].rstrip()
    return cut + "…"


def build_script_research_query(brief: VideoBrief, *, supplementary: bool = False) -> str:
    """
    Build a concise Tavily query (≤ 400 chars) centered on the theme.

    The previous version concatenated the full video format summary, creator notes, theme, and a
    280-char nonfiction-bias paragraph — easily 700–900 chars, which Tavily rejects with 400 Bad
    Request. Tavily's docs are explicit: queries should be phrased "as you would for a web search
    agent, not as a long-form prompt". So we lead with the theme, add a short format hint, optionally
    surface a single line of creator notes, and append a brief nonfiction steering phrase.

    ``supplementary`` returns a second phrasing for short/vague themes (e.g. one word like "aliens"),
    biased toward documentary / encyclopedic angles to dodge entertainment SERPs.
    """
    secs = int(brief.target_duration_seconds)
    vtype = brief.video_type
    label = delivery_label(vtype)
    notes = (brief.content_notes or "").strip().replace("\n", " ")
    theme = (brief.theme or "").strip().replace("\n", " ")

    if supplementary:
        stem = theme or notes or "the topic"
        return _truncate_query(
            f"Credible factual overview of {stem}: scientific skepticism, history, official "
            f"investigations, mainstream reporting — not movies or TV. {_NONFICTION_BIAS}"
        )

    # Build the primary query in priority order so the hard cap trims from the end (least
    # important context first). Theme is always preserved — it's the actual search target.
    pieces: list[str] = []
    if theme:
        pieces.append(theme)
    fmt_hint = f"For a {secs}s {label} video"
    pieces.append(fmt_hint)
    theme_flat = theme
    if theme_flat and len(theme_flat) < 96 and len(theme_flat.split()) <= 3:
        # Single-word / very short themes: steer away from fiction-franchise SERPs.
        pieces.append("Interpret as a real-world topic, not a film title or franchise.")
    if notes:
        pieces.append(f"Notes: {notes[:120]}")
    if is_short_form(VideoType(vtype), secs):
        pieces.append(
            "Angle: viral hook facts, controversy, hidden numbers — not academic demography essays."
        )
    else:
        pieces.append(_NONFICTION_BIAS)

    return _truncate_query(". ".join(p.rstrip(".") for p in pieces) + ".")


def _should_run_supplementary_search(brief: VideoBrief) -> bool:
    notes = (brief.content_notes or "").strip()
    if len(notes) >= 80:
        return False
    theme = (brief.theme or "").replace("\n", " ").strip()
    return bool(theme) and len(theme) < 120 and len(theme.split()) <= 4


def _format_tavily_results(payload: dict[str, Any]) -> str:
    lines: list[str] = []
    ans = payload.get("answer")
    if isinstance(ans, str) and ans.strip():
        lines.append("SUMMARY (search synthesis)")
        lines.append(ans.strip())
        lines.append("")

    results = payload.get("results")
    if not isinstance(results, list):
        return "\n".join(lines).strip()

    for i, row in enumerate(results[:20], start=1):
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        url = str(row.get("url") or "").strip()
        content = str(row.get("content") or "").strip()
        if not content and not title:
            continue
        head = f"[{i}] {title}" if title else f"[{i}]"
        if url:
            head += f" — {url}"
        lines.append(head)
        if content:
            lines.append(content)
        lines.append("")
    return "\n".join(lines).strip()


def _tavily_search_once(query: str) -> dict[str, Any] | None:
    key = (settings.tavily_api_key or os.environ.get("TAVILY_API_KEY") or "").strip()
    if not key:
        return None

    body: dict[str, Any] = {
        "query": query,
        "search_depth": (settings.tavily_search_depth or "basic").strip(),
        "max_results": max(1, min(int(settings.tavily_max_results), 20)),
        "topic": (settings.tavily_topic or "general").strip(),
    }
    if settings.tavily_include_answer:
        body["include_answer"] = True

    if settings.tavily_exclude_entertainment_domains:
        extra = _parse_exclude_domains(settings.tavily_exclude_domains or "")
        if extra:
            body["exclude_domains"] = extra

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=60.0) as client:
            r = client.post(_TAVILY_SEARCH_URL, json=body, headers=headers)
            if r.status_code >= 400:
                detail = ""
                try:
                    payload = r.json()
                    if isinstance(payload, dict):
                        detail = str(payload.get("detail") or payload.get("error") or payload)
                except Exception:  # noqa: BLE001
                    detail = (r.text or "").strip()[:500]
                logger.warning(
                    "Tavily search failed: HTTP %s — %s (query_len=%d)",
                    r.status_code,
                    detail or "<empty body>",
                    len(query),
                )
                return None
            data = r.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Tavily search failed: %s (query_len=%d)", exc, len(query))
        return None

    return data if isinstance(data, dict) else None


def fetch_web_research_notes(brief: VideoBrief) -> str:
    """
    Return plain-text notes to inject into the script LLM prompt.

    Requires ``TAVILY_API_KEY`` (or settings.tavily_api_key) and
    ``script_web_research_enabled`` when using Tavily.
    """
    if not settings.script_web_research_enabled:
        return ""
    key = (settings.tavily_api_key or os.environ.get("TAVILY_API_KEY") or "").strip()
    if not key:
        return ""

    primary_q = build_script_research_query(brief, supplementary=False)
    if not primary_q:
        return ""

    chunks: list[str] = []
    primary = _tavily_search_once(primary_q)
    if primary:
        fmt = _format_tavily_results(primary)
        if fmt:
            chunks.append("=== PRIMARY SEARCH (aligned with video parameters) ===\n" + fmt)

    if _should_run_supplementary_search(brief):
        alt_q = build_script_research_query(brief, supplementary=True)
        if alt_q != primary_q:
            sec = _tavily_search_once(alt_q)
            if sec:
                fmt2 = _format_tavily_results(sec)
                if fmt2:
                    chunks.append(
                        "\n\n=== SUPPLEMENTARY SEARCH (factual / documentary angle on the same theme) ===\n" + fmt2
                    )

    merged = "\n".join(chunks).strip()
    if not merged:
        return ""
    return merged[:14000]

