"""Parse Omega UI overrides for image inference steps and LoRA adapters."""

from __future__ import annotations

import json
from typing import Any


def _parse_json(raw: str) -> Any:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _normalize_repo_id(repo_id: str) -> str:
    return (repo_id or "").strip().lower().rstrip("/")


def _repo_match_candidates(repo_id: str, fallback_repo_ids: list[str] | None) -> set[str]:
    raw = [(repo_id or "").strip()]
    if fallback_repo_ids:
        raw.extend(str(x).strip() for x in fallback_repo_ids if str(x).strip())
    out: set[str] = set()
    for item in raw:
        norm = _normalize_repo_id(item)
        if norm:
            out.add(norm)
        if "/" in item:
            leaf = _normalize_repo_id(item.rsplit("/", 1)[-1])
            if leaf:
                out.add(leaf)
    return out


def image_steps_for_repo(
    repo_id: str,
    *,
    global_override: int,
    steps_by_repo_json: str,
    fallback_repo_ids: list[str] | None = None,
) -> int:
    """
    Return effective step count for ``repo_id``.

    Priority: per-repo map → legacy global ``image_num_steps`` → 0 (caller uses catalog default).
    """
    data = _parse_json(steps_by_repo_json)
    if isinstance(data, dict):
        candidates = _repo_match_candidates(repo_id, fallback_repo_ids)
        for key, value in data.items():
            key_norm = _normalize_repo_id(str(key))
            key_leaf = (
                _normalize_repo_id(str(key).rsplit("/", 1)[-1]) if "/" in str(key) else ""
            )
            if key_norm not in candidates and (not key_leaf or key_leaf not in candidates):
                continue
            try:
                steps = int(value)
                if steps > 0:
                    return max(4, steps)
            except (TypeError, ValueError):
                pass
            break
    if global_override > 0:
        return max(4, int(global_override))
    return 0


def _snap_dim(n: int) -> int:
    """Diffusers expects spatial sizes aligned to 8."""
    v = max(64, min(2048, int(n)))
    return v - (v % 8)


def image_size_for_repo(
    repo_id: str,
    *,
    size_by_repo_json: str,
    fallback_repo_ids: list[str] | None = None,
) -> tuple[int, int] | None:
    """
    Return explicit ``(width, height)`` for ``repo_id`` from Omega Settings.

    ``None`` means no user override (caller uses catalog default or brief aspect).
    ``(-1, -1)`` means use video brief aspect only (caller handles).
    """
    data = _parse_json(size_by_repo_json)
    if not isinstance(data, dict):
        return None
    candidates = _repo_match_candidates(repo_id, fallback_repo_ids)
    for key, value in data.items():
        key_norm = _normalize_repo_id(str(key))
        key_leaf = (
            _normalize_repo_id(str(key).rsplit("/", 1)[-1]) if "/" in str(key) else ""
        )
        if key_norm not in candidates and (not key_leaf or key_leaf not in candidates):
            continue
        if not isinstance(value, dict):
            continue
        try:
            w = int(value.get("width", 0))
            h = int(value.get("height", 0))
        except (TypeError, ValueError):
            continue
        if w == -1 and h == -1:
            return (-1, -1)
        if w > 0 and h > 0:
            return (_snap_dim(w), _snap_dim(h))
        if w == 0 and h == 0:
            return None
        break
    return None


def parse_image_lora_adapters(raw_json: str) -> list[dict[str, Any]]:
    data = _parse_json(raw_json)
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        base = str(item.get("baseRepoId") or item.get("base_repo_id") or "").strip()
        adapter = str(item.get("adapterRepoId") or item.get("adapter_repo_id") or "").strip()
        if not base or not adapter:
            continue
        row: dict[str, Any] = {
            "base_repo_id": base,
            "adapter_repo_id": adapter,
        }
        file_name = str(item.get("adapterFile") or item.get("adapter_file") or "").strip()
        if file_name:
            row["adapter_file"] = file_name
        try:
            row["scale"] = float(item.get("scale", 1.0))
        except (TypeError, ValueError):
            row["scale"] = 1.0
        out.append(row)
    return out
