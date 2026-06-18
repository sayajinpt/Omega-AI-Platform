"""Track & list downloadable Hugging Face snapshots under ``tts/`` and ``image/``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from localgen.downloads import snapshot_ready
from localgen.paths import get_models_root

Kind = Literal["tts", "image", "video"]

MANIFEST_NAME = "installed_hf_models.json"


def repo_snapshot_dir(models_root: Path, kind: Kind, repo_id: str) -> Path:
    safe = repo_id.replace("/", "__")
    return models_root / kind / safe


def manifest_path(models_root: Path) -> Path:
    return models_root / MANIFEST_NAME


def _load_manifest(models_root: Path) -> dict[str, Any]:
    p = manifest_path(models_root)
    if not p.is_file():
        return {"version": 1, "entries": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "entries": []}
    if not isinstance(data, dict):
        return {"version": 1, "entries": []}
    entries = data.get("entries")
    if not isinstance(entries, list):
        data["entries"] = []
    return data


def _save_manifest(models_root: Path, data: dict[str, Any]) -> None:
    models_root.mkdir(parents=True, exist_ok=True)
    manifest_path(models_root).write_text(json.dumps(data, indent=2), encoding="utf-8")


def register_installed_model(models_root: Path, repo_id: str, kind: Kind, *, label: str | None = None) -> None:
    """Append or update a manifest entry (idempotent by repo_id + kind)."""
    rid = repo_id.strip()
    if not rid:
        return
    data = _load_manifest(models_root)
    entries: list[dict[str, Any]] = list(data.get("entries") or [])
    for e in entries:
        if isinstance(e, dict) and e.get("repo_id") == rid and e.get("kind") == kind:
            if label:
                e["label"] = label
            _save_manifest(models_root, data)
            return
    entry: dict[str, Any] = {"repo_id": rid, "kind": kind}
    if label:
        entry["label"] = label
    entries.append(entry)
    data["entries"] = entries
    _save_manifest(models_root, data)


def _dir_nonempty(path: Path) -> bool:
    try:
        return any(path.iterdir())
    except OSError:
        return False


def _folder_name_to_repo_id(folder: str) -> str | None:
    """Inverse of ``repo_id.replace('/', '__')`` for standard HF two-part ids."""
    if "__" not in folder:
        return None
    org, rest = folder.split("__", 1)
    if not org or not rest:
        return None
    return f"{org}/{rest}"


def _iter_snapshot_dirs(kind_dir: Path) -> list[tuple[str, Path]]:
    """
    Discover model folders under ``tts/`` or ``image/``.

    Supports Omega layout ``org__repo`` and manual ``org/repo`` nesting.
    """
    found: list[tuple[str, Path]] = []
    if not kind_dir.is_dir():
        return found
    for child in sorted(kind_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if "__" in child.name:
            rid = _folder_name_to_repo_id(child.name)
            if rid:
                found.append((rid, child))
            continue
        try:
            for sub in sorted(child.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    found.append((f"{child.name}/{sub.name}", sub))
            if not any(p[1] == child for p in found) and _dir_nonempty(child):
                found.append((child.name, child))
        except OSError:
            continue
    return found


def _on_disk(dest: Path, kind: Kind) -> bool:
    return snapshot_ready(dest, kind=kind)


def list_available_models(models_root: Path, kind: Kind) -> list[tuple[str, str, bool]]:
    """
    Return sorted rows ``(repo_id, label, on_disk)`` — catalog + manifest + stray folders.
    """
    from localgen.registry import (
        studio_suggested_image_catalog,
        studio_suggested_tts_catalog,
        studio_suggested_video_catalog,
    )

    rows: dict[str, tuple[str, str, bool]] = {}

    if kind == "tts":
        catalog = studio_suggested_tts_catalog()
    elif kind == "video":
        catalog = studio_suggested_video_catalog()
    else:
        catalog = studio_suggested_image_catalog()
    for title, info in catalog.items():
        rid = info.get("id") or ""
        if not rid:
            continue
        dest = repo_snapshot_dir(models_root, kind, rid)
        ok = _on_disk(dest, kind)
        rows[rid] = (rid, title, ok)

    data = _load_manifest(models_root)
    for e in data.get("entries") or []:
        if not isinstance(e, dict):
            continue
        if e.get("kind") != kind:
            continue
        rid = str(e.get("repo_id") or "").strip()
        if not rid:
            continue
        label = str(e.get("label") or "").strip() or rid
        dest = repo_snapshot_dir(models_root, kind, rid)
        ok = _on_disk(dest, kind)
        if rid in rows:
            _, prev_title, prev_ok = rows[rid]
            rows[rid] = (rid, prev_title, prev_ok or ok)
        else:
            rows[rid] = (rid, label, ok)

    for rid, folder in _iter_snapshot_dirs(models_root / kind):
        if rid not in rows:
            rows[rid] = (rid, f"{rid} (folder)", _on_disk(folder, kind))
        else:
            prev_rid, prev_title, prev_ok = rows[rid]
            rows[rid] = (prev_rid, prev_title, prev_ok or _on_disk(folder, kind))

    out = sorted(rows.values(), key=lambda x: x[1].lower())
    return out


def list_models_for_ui(kind: Kind, *, models_root: Path | None = None) -> list[tuple[str, str, bool]]:
    root = models_root if models_root is not None else get_models_root()
    return list_available_models(root, kind)
