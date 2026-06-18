"""Build standard five-field crons from weekday + local time presets."""

from __future__ import annotations


def hhmm_parts(text: str) -> tuple[int, int]:
    t = text.strip()
    parts = t.split(":")
    if len(parts) != 2:
        raise ValueError("Time must look like HH:MM (24h).")
    h = int(parts[0])
    m = int(parts[1])
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError("Hour must be 0–23, minute 0–59.")
    return h, m


def weekly_crons_for(times_hhmm: list[str], cron_dows: list[int]) -> list[str]:
    """One cron expression per distinct local clock time across selected weekdays."""
    ds = ",".join(str(x) for x in sorted(set(int(d) for d in cron_dows)))
    lines: list[str] = []
    for raw in times_hhmm:
        h, m = hhmm_parts(raw)
        lines.append(f"{m} {h} * * {ds}")
    return lines


PY_WEEKDAY_TO_CRON = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 0}


def weekday_bitmask_to_crondows(py_checked: dict[int, bool]) -> list[int]:
    """``py_checked[0]`` = Monday … ``py_checked[6]`` = Sunday → cron dow numbers."""
    dows = [PY_WEEKDAY_TO_CRON[d] for d in range(7) if py_checked.get(d)]
    return sorted(set(dows))
