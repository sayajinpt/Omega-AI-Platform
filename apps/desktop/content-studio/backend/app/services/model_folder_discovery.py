"""Find usable model weights under GENERATION_MODELS_DATA_DIR without hard-coded folder names."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from localgen.downloads import snapshot_ready

HF_REPO_SIDECAR = ".omega-hf-repo.json"
_MIN_CHECKPOINT_BYTES = 50 * 1024 * 1024
_SKIP_DIR_NAMES = frozenset({".cache", "blobs", "refs"})


def _skip_dir_name(name: str) -> bool:
    return not name or name.startswith(".") or name in _SKIP_DIR_NAMES


def _path_in_skipped_tree(path: Path) -> bool:
    return any(_skip_dir_name(part) for part in path.parts)


def pack_has_usable_weights(pack_dir: Path, *, min_bytes: int = _MIN_CHECKPOINT_BYTES) -> bool:
    """At least one real checkpoint outside ``.cache`` (not an LFS pointer)."""
    return snapshot_ready(pack_dir)


def pack_has_incomplete_download(pack_dir: Path) -> bool:
    from localgen.downloads import _has_incomplete_hf_download

    return _has_incomplete_hf_download(pack_dir)


def video_pack_readiness_error(pack_dir: Path) -> str | None:
    """Human-readable reason a video pack cannot load yet, or ``None`` when ready."""
    if not pack_dir.is_dir():
        return "Video model folder is missing."
    if pack_has_incomplete_download(pack_dir):
        return (
            "Download incomplete — weight files were interrupted (see .cache/huggingface/download). "
            "Re-download from Models → Model roles → Video."
        )
    root = find_diffusers_root(pack_dir) or pack_dir
    if not (root / "model_index.json").is_file():
        return "Video model folder has no model_index.json — re-download the full repo."
    if not snapshot_ready(root, kind="video"):
        return (
            "Download incomplete — no model weight files found in component folders. "
            "Re-download from Models → Model roles → Video."
        )
    return None


def _dir_nonempty(path: Path) -> bool:
    try:
        return any(path.iterdir())
    except OSError:
        return False


def resolve_hf_style_load_path(base: Path) -> Path | None:
    """
    Resolve the directory that ``from_pretrained`` should see.

    Supports:
    - Flat snapshot: files directly under ``base``
    - Hugging Face hub layout: ``base/snapshots/<revision>/`` (first non-empty revision wins)
    """
    if not base.is_dir():
        return None
    snaps = base / "snapshots"
    if snaps.is_dir():
        subs = sorted((p for p in snaps.iterdir() if p.is_dir()), key=lambda p: p.name)
        for sub in subs:
            if _dir_nonempty(sub):
                return sub
    if _dir_nonempty(base):
        return base
    return None


def find_diffusers_root(base: Path, *, max_depth: int = 3) -> Path | None:
    """
    Search ``base`` and its subdirectories (up to ``max_depth``) for a folder containing
    ``model_index.json`` — the entry-point file ``DiffusionPipeline.from_pretrained`` requires.

    Returns the deepest matching directory found via breadth-first search, or ``None`` if
    no ``model_index.json`` exists anywhere in the tree. Useful when an HF download placed
    the files inside a nested subfolder (e.g. an extra repo-named directory or a
    ``snapshots/<rev>/`` layout) so the loader still finds the right load path.
    """
    if not base.is_dir():
        return None
    queue: list[tuple[Path, int]] = [(base, 0)]
    while queue:
        node, depth = queue.pop(0)
        try:
            entries = list(node.iterdir())
        except OSError:
            continue
        if any(e.name == "model_index.json" and e.is_file() for e in entries):
            return node
        if depth >= max_depth:
            continue
        for e in entries:
            if e.is_dir() and not e.name.startswith(".") and e.name not in ("blobs", "refs"):
                queue.append((e, depth + 1))
    return None


def directory_listing_summary(path: Path, *, max_entries: int = 25) -> str:
    """Short human-readable listing for error logs (top-level entries, size hints, truncation tail)."""
    if not path.is_dir():
        return f"<not a directory: {path}>"
    try:
        entries = sorted(path.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        return f"<cannot list {path}: {exc}>"
    if not entries:
        return "<directory is empty>"
    out_lines: list[str] = []
    for e in entries[:max_entries]:
        if e.is_dir():
            try:
                child_count = sum(1 for _ in e.iterdir())
            except OSError:
                child_count = 0
            out_lines.append(f"  {e.name}/  ({child_count} entries)")
        else:
            try:
                size = e.stat().st_size
            except OSError:
                size = 0
            out_lines.append(f"  {e.name}  ({_format_size(size)})")
    if len(entries) > max_entries:
        out_lines.append(f"  … and {len(entries) - max_entries} more")
    return "\n".join(out_lines)


def _format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.2f} GB"


def _score_contents(path: Path, *, kind: str) -> int:
    score = 0
    try:
        entries = list(path.iterdir())
    except OSError:
        return 0
    names_lower = {p.name.lower() for p in entries}
    if "config.json" in names_lower:
        score += 4
    if kind in ("image", "video"):
        if "model_index.json" in names_lower:
            score += 12
        if any(p.suffix.lower() == ".safetensors" for p in entries):
            score += 6
        if any(p.suffix.lower() == ".bin" for p in entries):
            score += 2
    else:
        if any(p.suffix.lower() == ".safetensors" for p in entries):
            score += 8
        if any(p.suffix.lower() == ".bin" for p in entries):
            score += 3
    return score


def discover_under_category(models_root: Path, category: str) -> Path | None:
    """
    Scan ``models_root/<category>/*/`` — **any** subdirectory name — and return the best
    resolved load path (see :func:`resolve_hf_style_load_path`).
    """
    cat = models_root / category
    if not cat.is_dir():
        return None
    tops = sorted((p for p in cat.iterdir() if p.is_dir()), key=lambda p: p.name.lower())
    best_score = -1
    best_path: Path | None = None
    for top in tops:
        resolved = resolve_hf_style_load_path(top)
        if resolved is None:
            continue
        if category == "video":
            diff_root = find_diffusers_root(resolved) or resolved
            if not snapshot_ready(diff_root, kind="video"):
                continue
        sc = _score_contents(resolved, kind=category)
        pick = False
        if best_path is None:
            pick = True
        elif sc > best_score:
            pick = True
        elif sc == best_score and str(resolved) < str(best_path):
            pick = True
        if pick:
            best_score = sc
            best_path = resolved
    return best_path


def discover_tts_model_dir(models_root: Path) -> Path | None:
    return discover_under_category(models_root, "tts")


def discover_image_model_dir(models_root: Path) -> Path | None:
    return discover_under_category(models_root, "image")


def discover_video_model_dir(models_root: Path) -> Path | None:
    return discover_under_category(models_root, "video")


def _read_model_index_class(pack_dir: Path) -> str | None:
    root = find_diffusers_root(pack_dir) or pack_dir
    path = root / "model_index.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    cls = str(data.get("_class_name") or "").strip()
    return cls or None


def infer_video_model_info_from_dir(pack_dir: Path, repo_id: str | None) -> dict[str, Any]:
    """Catalog-shaped defaults for any diffusers T2V folder (``model_index.json`` on disk)."""
    rid = (repo_id or "discovered").strip() or "discovered"
    load_dir = find_diffusers_root(pack_dir) or pack_dir
    pipeline_cls = _read_model_index_class(load_dir) or ""
    cls_lower = pipeline_cls.lower()
    frames = 61
    steps = 30
    fps = 15
    if "720" in cls_lower or "720" in rid.lower():
        frames = 121
        steps = 50
        fps = 24
    return {
        "id": rid,
        "engine": "diffusers_auto",
        "type": "diffusers_auto",
        "pipeline_class": pipeline_cls,
        "default_num_frames": frames,
        "default_num_steps": steps,
        "default_fps": fps,
        "default_guidance_scale": 6.0,
        "default_dtype": "bfloat16",
        "supports_negative_prompt": True,
    }


def resolve_video_pack_dir(repo_id: str, gen_root: Path) -> tuple[Path | None, str]:
    """Locate video weights for ``repo_id`` under ``video/<org__repo>/`` (same layout as image/TTS)."""
    rid = repo_id.strip()
    if not rid:
        return None, ""

    search_roots: list[Path] = [gen_root / "video"]
    parent = gen_root.parent
    if parent.is_dir() and parent.resolve() != gen_root.resolve():
        search_roots.append(parent)

    folder_names = [rid.replace("/", "__"), rid.split("/")[-1]]
    for root in search_roots:
        for folder in folder_names:
            base = root / folder
            resolved = resolve_hf_style_load_path(base)
            if resolved is None:
                continue
            diff_root = find_diffusers_root(resolved) or resolved
            if snapshot_ready(diff_root, kind="video"):
                label = "generation-models" if root.name == "video" else "models dir"
                return diff_root, f"{label} ({base})"
    return None, ""


def read_hf_repo_sidecar(pack_dir: Path) -> str | None:
    """Read ``.omega-hf-repo.json`` written by the Omega desktop app after HF downloads."""
    path = pack_dir / HF_REPO_SIDECAR
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    rid = str(data.get("repo_id") or "").strip()
    return rid or None


def _folder_name_to_repo_id(folder: str) -> str | None:
    if "__" not in folder:
        return None
    org, rest = folder.split("__", 1)
    if not org or not rest:
        return None
    return f"{org}/{rest}"


def image_pack_folder_names(repo_id: str) -> list[str]:
    """Candidate directory names for a HF repo (Content Studio ``org__repo`` or Model Studio leaf)."""
    rid = repo_id.strip()
    if not rid:
        return []
    names: list[str] = []
    for candidate in (rid.replace("/", "__"), rid.split("/")[-1]):
        c = candidate.strip()
        if c and c not in names:
            names.append(c)
    return names


def find_large_checkpoint_file(pack_dir: Path) -> Path | None:
    """Largest ``.safetensors`` / ``.ckpt`` under ``pack_dir`` that looks like a real checkpoint."""
    best: Path | None = None
    best_size = 0
    if not pack_dir.is_dir():
        return None
    for pattern in ("*.safetensors", "*.ckpt"):
        for p in pack_dir.rglob(pattern):
            if not p.is_file() or p.name.startswith(".") or _path_in_skipped_tree(p):
                continue
            try:
                size = p.stat().st_size
            except OSError:
                continue
            if size >= _MIN_CHECKPOINT_BYTES and size > best_size:
                best_size = size
                best = p
    return best


def _infer_single_file_pipeline(repo_id: str, ckpt: Path) -> tuple[str, str]:
    """
    Pick diffusers ``single_file_class`` and ``config_repo_id`` for an unknown checkpoint.

    Heuristics cover the most common HF search downloads: SD 1.5, SDXL, and SD3 single files.
    """
    rid = repo_id.lower()
    name = ckpt.name.lower()
    try:
        size = ckpt.stat().st_size
    except OSError:
        size = 0

    sd3_markers = ("sd3", "stable-diffusion-3", "diffusion-3")
    if any(m in rid or m in name for m in sd3_markers):
        return "StableDiffusion3Pipeline", "stabilityai/stable-diffusion-3.5-medium"

    sdxl_markers = ("sdxl", "-xl", "xl-", "2.5", "4.0", "interdiffusion-2", "interdiffusion-4")
    sd15_markers = ("nano", "sd15", "sd1.5", "v1-5", "v1.5", "-1.5", "sd-1")

    if any(m in rid or m in name for m in sdxl_markers):
        return "StableDiffusionXLPipeline", "stabilityai/stable-diffusion-xl-base-1.0"
    if any(m in rid or m in name for m in sd15_markers):
        return "StableDiffusionPipeline", "runwayml/stable-diffusion-v1-5"

    # Size fallback: SDXL checkpoints are typically ~5–7 GB; SD 1.5 ~2–4 GB.
    if size >= 5 * 1024**3:
        return "StableDiffusionXLPipeline", "stabilityai/stable-diffusion-xl-base-1.0"
    if size >= 1 * 1024**3:
        return "StableDiffusionPipeline", "runwayml/stable-diffusion-v1-5"

    return "StableDiffusionXLPipeline", "stabilityai/stable-diffusion-xl-base-1.0"


def infer_image_model_info_from_dir(pack_dir: Path, repo_id: str) -> dict[str, Any]:
    """
    Build a runtime catalog-shaped dict from on-disk layout when the repo is not in
    ``IMAGE_MODEL_CATALOG`` (Model Studio downloads, community single-file checkpoints, etc.).
    """
    rid = (repo_id or "discovered").strip() or "discovered"
    load_dir = find_diffusers_root(pack_dir) or pack_dir

    if (load_dir / "model_index.json").is_file():
        return {
            "id": rid,
            "engine": "diffusers_auto",
            "type": "diffusers_auto",
            "default_num_steps": 25,
            "default_guidance_scale": 5.0,
            "default_dtype": "bfloat16",
            "supports_negative_prompt": True,
            "supports_adapters": True,
        }

    ckpt = find_large_checkpoint_file(pack_dir)
    if ckpt is not None:
        pipeline_cls, config_repo = _infer_single_file_pipeline(rid, ckpt)
        try:
            target = str(ckpt.relative_to(pack_dir)).replace("\\", "/")
        except ValueError:
            target = ckpt.name
        steps = 28 if pipeline_cls == "StableDiffusionXLPipeline" else 25
        return {
            "id": rid,
            "engine": "diffusers_single_file",
            "type": "diffusers_single_file",
            "single_file_class": pipeline_cls,
            "single_file_target": target,
            "config_repo_id": config_repo,
            "default_num_steps": steps,
            "default_guidance_scale": 5.0,
            "default_dtype": "float16",
            "supports_negative_prompt": True,
        }

    return {
        "id": rid,
        "type": "checkpoint",
        "engine": "sd3",
        "default_num_steps": 8,
        "default_guidance_scale": 7.0,
        "default_dtype": "float16",
        "supports_negative_prompt": True,
    }


def resolve_image_pack_dir(repo_id: str, gen_root: Path) -> tuple[Path | None, str]:
    """
    Locate image weights for ``repo_id`` under Content Studio layout or the parent models folder
    (Model Studio HF file downloads: ``<modelsDir>/<repo-leaf>/`` + optional sidecar).
    """
    rid = repo_id.strip()
    if not rid:
        return None, ""

    search_roots: list[Path] = [gen_root / "image"]
    parent = gen_root.parent
    if parent.is_dir() and parent.resolve() != gen_root.resolve():
        search_roots.append(parent)

    for root in search_roots:
        for folder in image_pack_folder_names(rid):
            base = root / folder
            resolved = resolve_hf_style_load_path(base)
            if resolved is not None:
                label = "generation-models" if root.name == "image" else "models dir"
                return resolved, f"{label} ({base})"

    if parent.is_dir():
        for child in sorted(parent.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            if child.name in ("generation-models", "router_models", "image-adapters"):
                continue
            sidecar_rid = read_hf_repo_sidecar(child)
            inferred = _folder_name_to_repo_id(child.name) if not sidecar_rid else None
            if sidecar_rid != rid and inferred != rid:
                continue
            resolved = resolve_hf_style_load_path(child)
            if resolved is not None:
                return resolved, f"models dir sidecar ({child})"

    return None, ""
