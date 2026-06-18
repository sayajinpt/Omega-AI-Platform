"""Text-to-video via diffusers — any installed HF video pipeline under ``video/``."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.generation_defaults import effective_video_repo_id
from app.services.model_folder_discovery import (
    discover_video_model_dir,
    find_diffusers_root,
    infer_video_model_info_from_dir,
    read_hf_repo_sidecar,
    resolve_video_pack_dir,
    video_pack_readiness_error,
)
from app.services.generation_video_settings import (
    T2V_MAX_FRAMES,
    frames_for_target_duration,
    video_size_for_repo,
    video_steps_for_repo,
)
from localgen.registry import VIDEO_MODEL_CATALOG, video_model_runtime_defaults


def generation_models_root() -> Path:
    from app.config import settings

    return Path(settings.generation_models_data_dir).expanduser().resolve()


def _catalog_entry_for_repo(repo_id: str, *, pack_dir: Path | None = None) -> dict[str, Any]:
    rid = (repo_id or "").strip()
    for entry in VIDEO_MODEL_CATALOG.values():
        if str(entry.get("id") or "").strip() == rid:
            return dict(entry)
    if pack_dir is not None:
        return infer_video_model_info_from_dir(pack_dir, rid or None)
    return {
        "id": rid or "unknown",
        "engine": "diffusers_auto",
        "type": "diffusers_auto",
        "default_num_frames": 61,
        "default_num_steps": 30,
        "default_fps": 15,
        "default_guidance_scale": 6.0,
        "default_dtype": "bfloat16",
        "supports_negative_prompt": True,
    }


def _resolve_video_model_dir_and_info(
    preferred_repo_id: str | None = None,
) -> tuple[Path | None, dict[str, Any], str]:
    root = generation_models_root()
    user_pin = (preferred_repo_id or "").strip() or None
    target_repo = user_pin or effective_video_repo_id(None)
    origin = f"pinned ({target_repo})" if user_pin else (
        f"default ({target_repo})" if target_repo else "auto-discovered"
    )

    if target_repo:
        resolved, pack_label = resolve_video_pack_dir(target_repo, root)
        if resolved is not None:
            info = _catalog_entry_for_repo(target_repo, pack_dir=resolved)
            origin_detail = f"{origin}; {pack_label}" if pack_label else origin
            return resolved, info, origin_detail

    discovered = discover_video_model_dir(root)
    if discovered is not None:
        sidecar = read_hf_repo_sidecar(discovered.parent if find_diffusers_root(discovered.parent) else discovered)
        inferred_repo = sidecar or target_repo or ""
        info = infer_video_model_info_from_dir(discovered, inferred_repo or None)
        return discovered, info, f"discovered ({discovered})"

    if target_repo:
        return None, _catalog_entry_for_repo(target_repo), origin
    return None, _catalog_entry_for_repo(""), origin


def _merge_negative_prompt(user_neg: str | None, catalog_neg: str) -> str | None:
    user = (user_neg or "").strip()
    base = (catalog_neg or "").strip()
    if not base:
        return user or None
    if not user:
        return base
    if base.lower() in user.lower():
        return user
    return f"{user}, {base}"


def run_t2v_clip(
    *,
    prompt: str,
    out_path: Path,
    hf_video_repo_id: str | None = None,
    negative_prompt: str | None = None,
    num_frames: int | None = None,
    num_steps: int | None = None,
    guidance_scale: float | None = None,
    fps: int | None = None,
    seed: int = 42,
    prefer_full_gpu: bool = False,
    target_duration_seconds: float | None = None,
) -> str:
    """Load the pinned (or discovered) video model, render one clip, dispose weights."""
    model_dir, model_info, origin_label = _resolve_video_model_dir_and_info(hf_video_repo_id)
    if model_dir is None:
        repo = (hf_video_repo_id or "").strip() or effective_video_repo_id(None)
        root = generation_models_root()
        pack_hint = ""
        if repo:
            base = root / "video" / repo.replace("/", "__")
            err = video_pack_readiness_error(base)
            if err:
                pack_hint = f" {err}"
        hint = (
            f"Video model «{repo}» is not installed.{pack_hint}"
            if repo
            else "No text-to-video model is installed."
        )
        raise RuntimeError(f"{hint} Download a diffusers T2V repo from Models → Model roles → Video.")

    readiness = video_pack_readiness_error(model_dir)
    if readiness:
        raise RuntimeError(readiness)

    defaults = video_model_runtime_defaults(model_info)
    from app.config import settings

    repo_label = str(model_info.get("id") or model_dir.name)
    video_steps_override = video_steps_for_repo(
        repo_label,
        global_override=max(0, int(getattr(settings, "video_num_steps", 0) or 0)),
        steps_by_repo_json=str(getattr(settings, "video_steps_by_repo_json", "") or ""),
        fallback_repo_ids=[
            str(hf_video_repo_id or "").strip(),
            str(getattr(settings, "default_hf_video_repo_id", "") or "").strip(),
        ],
    )
    if video_steps_override > 0:
        steps = max(1, video_steps_override)
    else:
        steps = max(1, int(num_steps or defaults["num_steps"]))
    guide = float(guidance_scale if guidance_scale is not None else defaults["guidance_scale"])
    out_fps = max(1, int(fps or defaults["fps"]))
    if num_frames is not None:
        frames = max(8, int(num_frames))
    elif target_duration_seconds is not None and target_duration_seconds > 0:
        computed = frames_for_target_duration(target_duration_seconds, out_fps)
        frames = max(8, computed) if computed > 0 else max(8, int(defaults["num_frames"]))
    else:
        frames = max(8, int(defaults["num_frames"]))
    height = defaults.get("height")
    width = defaults.get("width")
    size_override = video_size_for_repo(
        repo_label,
        size_by_repo_json=str(getattr(settings, "video_size_by_repo_json", "") or ""),
        fallback_repo_ids=[
            str(hf_video_repo_id or "").strip(),
            str(getattr(settings, "default_hf_video_repo_id", "") or "").strip(),
        ],
    )
    if size_override and size_override[0] > 0 and size_override[1] > 0:
        width, height = size_override
    decode_timestep = defaults.get("decode_timestep")
    decode_noise_scale = defaults.get("decode_noise_scale")
    supports_neg = bool(defaults["supports_negative_prompt"])
    merged_neg = _merge_negative_prompt(negative_prompt, defaults.get("default_negative_prompt") or "")

    from localgen.engines import generate_video_file, load_video_pipeline
    from localgen.torch_device import effective_use_gpu, log_image_acceleration

    log_image_acceleration()
    use_gpu = effective_use_gpu(True)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pipe, attn_label = load_video_pipeline(
        model_dir, model_info=model_info, use_gpu=use_gpu, full_gpu=prefer_full_gpu
    )
    try:
        generate_video_file(
            pipe,
            prompt=prompt,
            negative_prompt=merged_neg if supports_neg else None,
            num_frames=frames,
            num_steps=steps,
            guidance_scale=guide,
            seed=seed,
            out_path=out_path,
            fps=out_fps,
            height=height,
            width=width,
            decode_timestep=decode_timestep,
            decode_noise_scale=decode_noise_scale,
        )
    finally:
        try:
            from localgen.gpu_runtime import dispose_video_pipeline

            dispose_video_pipeline(pipe, reason="t2v_clip_done")
        except Exception:  # noqa: BLE001
            pass

    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise RuntimeError(f"Video model «{repo_label}» produced no output file")

    approx_sec = round(frames / out_fps, 1)
    duration_note = ""
    if target_duration_seconds is not None and target_duration_seconds > 0:
        requested = round(float(target_duration_seconds), 1)
        if abs(approx_sec - requested) > 0.6:
            duration_note = f", ~{approx_sec}s output (requested {requested}s; model max ~{round(T2V_MAX_FRAMES / out_fps, 1)}s per clip)"

    res_note = f", {width}x{height}" if width and height else ""

    return (
        f"Text-to-video ({repo_label}, {origin_label}, {frames} frames @ {out_fps} fps"
        f"{res_note}{duration_note}, attention={attn_label})"
    )
