"""User-chosen durations — no product min/max caps (only technical sanity)."""

from __future__ import annotations

# ~7 days: prevents accidental typos (e.g. seconds vs milliseconds), not a creative limit.
MAX_TECHNICAL_SECONDS = 7 * 24 * 3600


def normalize_duration_seconds(value: int | None, *, default: int = 600) -> int:
    if value is None:
        return default
    seconds = int(value)
    if seconds < 1:
        raise ValueError("max_duration_seconds must be at least 1.")
    if seconds > MAX_TECHNICAL_SECONDS:
        raise ValueError(
            f"max_duration_seconds exceeds technical limit ({MAX_TECHNICAL_SECONDS} seconds)."
        )
    return seconds
