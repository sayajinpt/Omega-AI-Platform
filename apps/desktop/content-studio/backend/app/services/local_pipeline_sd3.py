"""Generate per-scene images via any catalogued local diffusers pipeline (SD3 / Z-Image / generic) or solid placeholders."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import JobLog
from app.services.generation_models_paths import generation_models_root
from app.services.model_folder_discovery import (
    directory_listing_summary,
    discover_image_model_dir,
    find_diffusers_root,
    infer_image_model_info_from_dir,
    resolve_hf_style_load_path,
    resolve_image_pack_dir,
)


from app.services.generation_defaults import effective_image_repo_id
from app.services.job_cancel import JobCancelledError, ensure_not_cancelled
from localgen.registry import DEFAULT_IMAGE_CATALOG_KEY

# Non–LoRA branch in ``load_sd3_pipeline`` uses plain ``from_pretrained(model_dir)``.
_DISCOVERED_SD3_INFO: dict[str, Any] = {
    "type": "checkpoint",
    "engine": "sd3",
    "id": "discovered",
}


def _catalog_entry_for_repo(repo_id: str, pack_dir: Path | None = None) -> dict[str, Any]:
    from app.services import local_generation

    catalog = local_generation.catalog_image_models()
    for _name, entry in catalog.items():
        if entry.get("id") == repo_id:
            return dict(entry)
    if pack_dir is not None:
        return infer_image_model_info_from_dir(pack_dir, repo_id)
    out = dict(_DISCOVERED_SD3_INFO)
    out["id"] = repo_id
    return out


def _engine_label(model_info: dict[str, Any]) -> str:
    """Human-readable engine label for log messages ('SD3', 'Z-Image-Turbo', 'InterDiffusion-2.5', …)."""
    engine = (model_info.get("engine") or model_info.get("type") or "").strip().lower()
    rid = str(model_info.get("id") or "")
    if engine == "zimage" or "z-image" in rid.lower():
        return "Z-Image"
    if engine in (
        "diffusers_auto",
        "diffusers_generic",
        "diffusers",
        "diffusers_single_file",
        "single_file",
    ):
        tail = rid.split("/", 1)[-1] if "/" in rid else rid
        return tail or "Diffusers"
    return "SD3"


def _storage_images_dir(project_id: str, job_id: str) -> Path:
    root = Path(settings.storage_path).expanduser().resolve()
    return root / project_id / job_id / "images"


def _copy_images_from_prior_job(
    db: Session,
    *,
    project_id: str,
    source_job_id: str,
    dest_job_id: str,
    scenes: list[dict[str, Any]],
    aspect: str,
) -> str:
    """Reuse PNGs from a succeeded job (re-voice with new TTS, same visuals)."""
    import shutil

    src_dir = _storage_images_dir(project_id, source_job_id)
    dest_dir = _storage_images_dir(project_id, dest_job_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    width, height = _dims_from_aspect(aspect)
    copied = 0
    for i, sc in enumerate(scenes):
        if not isinstance(sc, dict):
            continue
        sn = int(sc.get("scene_number") or i + 1)
        name = f"scene_{sn:02d}.png"
        src = src_dir / name
        dest = dest_dir / name
        if src.is_file():
            shutil.copy2(src, dest)
            copied += 1
        else:
            _placeholder_png(dest, width, height, f"Scene {sn} (missing source image)")
    db.add(
        JobLog(
            job_id=dest_job_id,
            level="info",
            message=(
                f"Images: reused {copied}/{len(scenes)} scene PNG(s) from job {source_job_id[:8]} "
                f"(re-voice — skipped diffusion)."
            ),
        )
    )
    db.commit()
    return f"Reused {copied} scene image(s) from prior job."


def _dims_from_aspect(aspect: str) -> tuple[int, int]:
    a = (aspect or "16:9").strip()
    if a in ("9:16", "vertical"):
        return 720, 1280
    return 1280, 720


def _image_gen_dimensions(
    aspect: str,
    model_info: dict[str, Any],
    *,
    repo_id: str = "",
    size_by_repo_json: str = "",
    fallback_repo_ids: list[str] | None = None,
) -> tuple[int, int]:
    """Catalog default, Settings override, or video brief aspect (16:9 / 9:16)."""
    from app.services.generation_image_settings import image_size_for_repo

    override = image_size_for_repo(
        repo_id,
        size_by_repo_json=size_by_repo_json,
        fallback_repo_ids=fallback_repo_ids,
    )
    if override == (-1, -1):
        return _dims_from_aspect(aspect)
    if override is not None:
        return override

    dw = model_info.get("default_width")
    dh = model_info.get("default_height")
    if dw and dh:
        return int(dw), int(dh)
    return _dims_from_aspect(aspect)


def _placeholder_png(path: Path, width: int, height: int, label: str) -> None:
    """Light gray slate with readable text — not empty black (that would mimic broken SD3)."""
    from PIL import Image, ImageDraw, ImageFont

    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (width, height), color=(105, 112, 124))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default()
    except Exception:  # noqa: BLE001
        font = None

    lines: list[str] = [
        "PLACEHOLDER — SD3 did not produce pixels",
        "",
        (label or "")[:500],
        "",
        "Install weights under GENERATION_MODELS_DATA_DIR/image/",
        "or download from the Models panel.",
    ]
    y = max(18, min(height // 30, 48))
    for ln in lines:
        draw.text((22, y), ln[:120], fill=(28, 30, 36), font=font)
        y += 19
        if y > height - 22:
            break
    img.save(path, format="PNG")


def _refine_load_path(resolved: Path, model_info: dict[str, Any]) -> Path:
    """
    For diffusers-pipeline engines, prefer a deeper subdir that actually contains
    ``model_index.json`` over the top-level base — handles HF downloads that landed in
    a nested folder (e.g. ``base/<repo-name>/model_index.json``).
    """
    engine = (model_info.get("engine") or model_info.get("type") or "").strip().lower()
    if engine in ("sd3", "checkpoint", "lora", "zimage", "diffusers", "diffusers_auto", "diffusers_generic"):
        deeper = find_diffusers_root(resolved)
        if deeper is not None and deeper != resolved:
            return deeper
    return resolved


def _ensure_single_file_config(
    model_info: dict[str, Any], models_root: Path
) -> tuple[Path | None, str | None]:
    """
    Pre-fetch (once) the small config / tokenizer files the single-file engine needs from a
    base diffusers repo, into a controlled ``local_dir`` so HF Hub never tries to create
    symlinks (Windows ``WinError 1314``).

    Returns ``(config_dir, error)`` — exactly one is ``None``. ``config_dir`` is suitable for
    passing as ``config=`` to ``DiffusionPipeline.from_single_file``. Returns ``(None, None)``
    when this catalog entry doesn't declare a ``config_repo_id``.
    """
    config_repo = str(model_info.get("config_repo_id") or "").strip()
    if not config_repo:
        return None, None
    safe = config_repo.replace("/", "__")
    local_dir = models_root / "image" / "_config_cache" / safe
    sentinel = local_dir / "model_index.json"
    if sentinel.is_file():
        return local_dir, None
    try:
        from localgen.downloads import download_config_only_snapshot

        download_config_only_snapshot(config_repo, local_dir)
    except Exception as exc:  # noqa: BLE001
        return None, f"failed to fetch config dependency `{config_repo}`: {exc}"
    if not sentinel.is_file():
        return None, (
            f"config dependency `{config_repo}` downloaded to `{local_dir}` but no "
            "`model_index.json` was produced — repo layout may be unsupported."
        )
    return local_dir, None


def _single_file_checkpoint_names(model_info: dict[str, Any]) -> list[str]:
    """Preferred checkpoint filename(s) for single-file engines (catalog target, then HF default)."""
    target = str(model_info.get("single_file_target") or "model.safetensors").strip()
    names = [target]
    if target != "model.safetensors":
        names.append("model.safetensors")
    return names


def _single_file_checkpoint_exists(model_dir: Path, model_info: dict[str, Any]) -> bool:
    for name in _single_file_checkpoint_names(model_info):
        if (model_dir / name).is_file():
            return True
        if any(model_dir.rglob(name)):
            return True
    return False


def _missing_entry_point(model_dir: Path, model_info: dict[str, Any], engine: str) -> str | None:
    """
    Return the name of the file the engine needs but cannot find under ``model_dir``,
    or ``None`` if the directory looks ready to load. Used by ``run_sd3_images_for_job``
    to fail fast with a helpful message instead of falling into the diffusers loader.
    """
    eng = (engine or "").strip().lower()
    if eng in ("diffusers_single_file", "single_file"):
        if _single_file_checkpoint_exists(model_dir, model_info):
            return None
        return _single_file_checkpoint_names(model_info)[0]
    if eng in ("sd3", "zimage", "diffusers_auto", "diffusers_generic", "diffusers"):
        return None if (model_dir / "model_index.json").is_file() else "model_index.json"
    return None


def _resolve_sd3_model_dir_and_info(preferred_repo_id: str | None = None) -> tuple[Path | None, dict[str, Any], str]:
    """
    Prefer a pinned HF repo under ``image/<org__repo>/``, then scan ``image/*``, then catalog layout.
    Returns ``(path, model_info_for_load, description_for_logs)``.

    For diffusers-style engines, the returned path is the deepest directory that contains
    ``model_index.json`` so ``DiffusionPipeline.from_pretrained`` works even when the HF
    download placed files in a nested subfolder.
    """
    from app.services import local_generation

    root = generation_models_root()
    user_pin = (preferred_repo_id or "").strip() or None
    target_repo = user_pin or effective_image_repo_id(None)
    origin = f"pinned ({target_repo})" if user_pin else f"default ({target_repo})"

    resolved, pack_label = resolve_image_pack_dir(target_repo, root)
    if resolved is not None:
        info = _catalog_entry_for_repo(target_repo, pack_dir=resolved)
        origin_detail = f"{origin}; {pack_label}" if pack_label else origin
        return _refine_load_path(resolved, info), info, origin_detail

    discovered = discover_image_model_dir(root)
    if discovered is not None:
        info = infer_image_model_info_from_dir(discovered, target_repo)
        return _refine_load_path(discovered, info), info, f"discovered ({discovered})"

    catalog = local_generation.catalog_image_models()
    entry = catalog.get(DEFAULT_IMAGE_CATALOG_KEY) or next(iter(catalog.values()), None)
    if not entry:
        return None, dict(_DISCOVERED_SD3_INFO), ""

    repo_id = entry["id"]
    resolved, pack_label = resolve_image_pack_dir(repo_id, root)
    if resolved is not None:
        info = dict(entry)
        label = f"catalog layout ({pack_label})" if pack_label else f"catalog layout ({resolved})"
        return _refine_load_path(resolved, info), info, label

    return None, dict(_DISCOVERED_SD3_INFO), ""


def run_sd3_images_for_job(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    brief_json: dict[str, Any],
    skip_sd3: bool = False,
    reuse_images_from_job_id: str | None = None,
    hf_image_repo_id: str | None = None,
    image_style: str | None = None,
    image_run_kwargs: dict[str, Any] | None = None,
) -> str:
    """
    Write ``images/scene_NN.png`` for each scene.

    Picks the right loader (SD3 / Z-Image / generic diffusers) from the catalog entry
    of the pinned ``hf_image_repo_id`` (or the auto-discovered folder). Per-model
    defaults — num_steps, guidance_scale, dtype, negative-prompt support — are read
    from the catalog entry via :func:`localgen.registry.image_model_runtime_defaults`.

    Falls back to placeholder PNGs when SD3 is skipped or weights are missing.
    """
    from app.services.script_scenes import sorted_script_scenes

    scenes = sorted_script_scenes(script_content)
    if not scenes:
        return "Images: no scenes."

    aspect = str(brief_json.get("aspect_ratio") or "16:9")
    out_dir = _storage_images_dir(project_id, job_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    reuse_from = (reuse_images_from_job_id or "").strip()
    if reuse_from:
        return _copy_images_from_prior_job(
            db,
            project_id=project_id,
            source_job_id=reuse_from,
            dest_job_id=job_id,
            scenes=scenes,
            aspect=aspect,
        )

    if skip_sd3:
        width, height = _dims_from_aspect(aspect)
        for i, sc in enumerate(scenes):
            if not isinstance(sc, dict):
                continue
            sn = int(sc.get("scene_number") or i + 1)
            _placeholder_png(out_dir / f"scene_{sn:02d}.png", width, height, f"Scene {sn} (image gen skipped)")
        db.add(JobLog(job_id=job_id, level="info", message="Images: skipped (job payload); placeholder PNGs written."))
        db.commit()
        return "Image gen skipped — placeholders."

    user_pin_img = (hf_image_repo_id or "").strip() or None
    model_dir, model_info, origin_label = _resolve_sd3_model_dir_and_info(user_pin_img)
    base_repo = str(model_info.get("id") or user_pin_img or "").strip()
    width, height = _image_gen_dimensions(
        aspect,
        model_info,
        repo_id=base_repo,
        size_by_repo_json=str(getattr(settings, "image_size_by_repo_json", "") or ""),
        fallback_repo_ids=[
            str(user_pin_img or "").strip(),
            str(getattr(settings, "default_hf_image_repo_id", "") or "").strip(),
        ],
    )
    engine_label = _engine_label(model_info)
    _log_pending = 0

    def log(lvl: str, msg: str) -> None:
        nonlocal _log_pending
        db.add(JobLog(job_id=job_id, level=lvl, message=msg))
        _log_pending += 1
        if _log_pending >= 6:
            db.commit()
            _log_pending = 0

    def log_flush() -> None:
        nonlocal _log_pending
        if _log_pending:
            db.commit()
            _log_pending = 0

    if user_pin_img and not origin_label.startswith("pinned"):
        log(
            "warning",
            f"Image gen: pinned repo «{user_pin_img}» not found under "
            f"{generation_models_root()} or {generation_models_root().parent} — using automatic folder selection.",
        )
    if model_dir is None:
        ph_w, ph_h = _dims_from_aspect(aspect)
        log(
            "warning",
            "Image gen: no usable folder under "
            f"{generation_models_root() / 'image'} (any checkpoint folder name OK); using placeholder PNGs.",
        )
        for i, sc in enumerate(scenes):
            if isinstance(sc, dict):
                sn = int(sc.get("scene_number") or i + 1)
                _placeholder_png(out_dir / f"scene_{sn:02d}.png", ph_w, ph_h, f"Scene {sn}")
        return "Image weights not found — placeholders."

    from localgen.engines import generate_image_file, load_image_pipeline
    from localgen.gpu_runtime import dispose_sd3_pipeline
    from localgen.registry import image_model_runtime_defaults, style_preset_by_key

    img_kw = dict(image_run_kwargs or {})
    chosen_key = (
        str(img_kw.get("style_preset") or img_kw.get("image_style") or image_style or "")
        .strip()
        .lower()
        or None
    )
    style_entry = style_preset_by_key(chosen_key) if chosen_key else None
    if style_entry is None:
        # Auto / unknown → no style steering; let the scene's raw prompt drive the look.
        prefix = ""
        negative = ""
        style_label = chosen_key or "auto"
    else:
        prefix = str(style_entry.get("prompt_prefix", "") or "")
        negative = str(style_entry.get("negative", "") or "")
        style_label = str(style_entry.get("key") or chosen_key or "auto")

    from app.services.generation_image_settings import image_steps_for_repo, parse_image_lora_adapters

    defaults = image_model_runtime_defaults(model_info)
    base_repo = str(model_info.get("id") or user_pin_img or "").strip()
    image_steps_override = image_steps_for_repo(
        base_repo,
        global_override=max(0, int(getattr(settings, "image_num_steps", 0) or 0)),
        steps_by_repo_json=str(getattr(settings, "image_steps_by_repo_json", "") or ""),
        fallback_repo_ids=[
            str(user_pin_img or "").strip(),
            str(getattr(settings, "default_hf_image_repo_id", "") or "").strip(),
        ],
    )
    sd3_steps_override = max(0, int(getattr(settings, "sd3_num_steps", 0) or 0))
    if image_steps_override > 0:
        num_steps = max(4, image_steps_override)
    elif int(img_kw.get("num_inference_steps") or 0) > 0:
        num_steps = max(1, int(img_kw["num_inference_steps"]))
    elif defaults["engine"] == "sd3" and sd3_steps_override > 0:
        num_steps = max(4, sd3_steps_override)
    else:
        num_steps = max(1, int(defaults["num_steps"]))
    if image_steps_override > 0 and image_steps_override > int(defaults["num_steps"]):
        log(
            "warning",
            f"Image gen: using {num_steps} steps from Settings (catalog default for this model is "
            f"{defaults['num_steps']}). Standalone qwen_tts_gui defaults to 8 — lower steps if renders are slow.",
        )
    lora_adapters = parse_image_lora_adapters(
        str(getattr(settings, "image_lora_adapters_json", "") or "")
    )
    guidance_scale = float(img_kw.get("guidance_scale") or defaults["guidance_scale"])
    supports_neg = bool(
        img_kw.get("supports_negative_prompt")
        if "supports_negative_prompt" in img_kw
        else defaults["supports_negative_prompt"]
    )

    log(
        "info",
        f"Image gen: loading {engine_label} pipeline — {origin_label}; "
        f"path={model_dir}; engine={defaults.get('engine') or defaults.get('type')}; "
        f"steps={num_steps}, guidance={guidance_scale}, dtype={defaults['dtype']}, "
        f"size={width}x{height}, neg_prompt={'on' if supports_neg else 'off'}, style={style_label}",
    )
    try:
        import sys

        import torch
        from localgen.attention_backend import flash_attn_installed, log_flash_attn_probe

        log_flash_attn_probe("image-runtime")
        cuda = bool(torch.cuda.is_available())
        bits = [
            f"worker_python={sys.executable}",
            f"torch={getattr(torch, '__version__', '?')}",
            f"cuda={cuda}",
            f"flash_attn_pkg={flash_attn_installed()}",
            f"models_root={generation_models_root()}",
        ]
        if cuda:
            bits.append(f"device={torch.cuda.get_device_name(0)}")
        log("info", "Image runtime: " + "; ".join(bits))
        from localgen.attention_backend import flash_attn_installed

        log(
            "info",
            "Image load mode: auto UNet attention patch "
            f"(flash_attn={'yes' if flash_attn_installed() else 'no'}; SDPA fallback when needed)",
        )
        from localgen.engines import _image_inference_standalone_parity, _sdxl_text_encoder_offload_enabled

        vram_mode = os.environ.get("OMEGA_CS_IMAGE_VRAM_MODE", "all_gpu").strip() or "all_gpu"
        if _sdxl_text_encoder_offload_enabled():
            log(
                "info",
                f"Image gen: VRAM mode={vram_mode} — SDXL text encoders may offload to CPU before UNet steps.",
            )
        elif _image_inference_standalone_parity():
            log(
                "info",
                "Image gen: qwen_tts_gui parity (from_pretrained + pipe(prompt=…); unload before TTS).",
            )
            if _sdxl_text_encoder_offload_enabled():
                log(
                    "warning",
                    f"Image gen: VRAM mode={vram_mode} would offload text encoders, but inference uses "
                    "standalone parity (all-GPU pipe call). Set Image VRAM to All GPU for fastest steps.",
                )
        else:
            log(
                "info",
                f"Image gen: VRAM mode={vram_mode} — extended Omega image path. Image models unload before TTS.",
            )
    except Exception as exc:  # noqa: BLE001
        log("warning", f"Image runtime probe failed: {exc}")

    if defaults["engine"] in ("diffusers_single_file", "single_file"):
        cfg_dir, cfg_err = _ensure_single_file_config(model_info, generation_models_root())
        if cfg_err is not None:
            log("error", f"Image gen ({engine_label}): {cfg_err}; filling placeholders.")
            for i, sc in enumerate(scenes):
                if isinstance(sc, dict):
                    sn = int(sc.get("scene_number") or i + 1)
                    _placeholder_png(out_dir / f"scene_{sn:02d}.png", width, height, f"Scene {sn} (config dep failed)")
            return f"{engine_label} config dependency missing — placeholders."
        if cfg_dir is not None:
            model_info = dict(model_info)
            model_info["_single_file_config_path"] = str(cfg_dir)
            log("info", f"Image gen ({engine_label}): using local config dir `{cfg_dir}`.")

    missing_file = _missing_entry_point(model_dir, model_info, defaults["engine"])
    if missing_file is not None:
        base_for_listing = generation_models_root() / "image" / str(model_info.get("id", "")).replace("/", "__")
        listing_root = base_for_listing if base_for_listing.is_dir() else model_dir
        listing = directory_listing_summary(listing_root)
        log(
            "error",
            (
                f"Image gen ({engine_label}): missing `{missing_file}` in resolved load path "
                f"`{model_dir}`. The download appears incomplete or to have landed in an "
                f"unexpected layout. Use the Models panel to re-download "
                f"`{model_info.get('id', '?')}`. Top-level of `{listing_root}`:\n{listing}"
            ),
        )
        for i, sc in enumerate(scenes):
            if isinstance(sc, dict):
                sn = int(sc.get("scene_number") or i + 1)
                _placeholder_png(out_dir / f"scene_{sn:02d}.png", width, height, f"Scene {sn} (model missing)")
        return f"{engine_label} weights incomplete — placeholders. Re-download `{model_info.get('id', '?')}`."

    from app.services.pipeline_warm_cache import get_warm_image_pipeline, set_warm_image_pipeline

    pipe = None
    attn_label = ""
    # Worker jobs must not leave SDXL in VRAM for TTS (warm cache only helps desktop re-clicks).
    keep_pipe_warm = os.environ.get("OMEGA_CS_WORKER", "").strip() != "1"
    try:
        try:
            import torch

            if torch.cuda.is_available():
                free_b, total_b = torch.cuda.mem_get_info(0)
                free_mib = free_b // (1024 * 1024)
                total_mib = total_b // (1024 * 1024)
                lvl = "info" if free_mib >= 4096 else "warning"
                log(
                    lvl,
                    f"CUDA VRAM before image load: {free_mib} MiB free / {total_mib} MiB total "
                    f"(SDXL needs ~8–10 GiB headroom for fast steps; low free VRAM causes ~15–20 s/step).",
                )
        except Exception:  # noqa: BLE001
            pass
        warm = get_warm_image_pipeline(model_dir, base_repo)
        if warm is not None:
            pipe, attn_label, _warm_info = warm
            log("info", f"Image gen: reusing warm pipeline in VRAM ({origin_label}); attention = {attn_label}")
            try:
                import sys

                print(
                    f"localgen.image-diffusers: reusing warm pipeline ({origin_label})",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:  # noqa: BLE001
                pass
        else:
            from localgen.torch_device import effective_use_gpu, log_image_acceleration

            log_image_acceleration()
            use_gpu = effective_use_gpu(True)
            pipe, attn_label = load_image_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)
            log("info", f"Image gen: loaded pipeline — attention = {attn_label}")
            try:
                import sys

                print(
                    f"localgen.image-diffusers: loaded pipeline ({origin_label}) attention={attn_label}",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:  # noqa: BLE001
                pass
        from app.services.pipeline_job_pipes import register_job_image_pipe

        register_job_image_pipe(job_id, pipe)
        if lora_adapters:
            from localgen.adapters import apply_image_lora_adapters

            applied_loras = apply_image_lora_adapters(
                pipe,
                base_repo_id=base_repo,
                adapters=lora_adapters,
                models_root=generation_models_root(),
            )
            if applied_loras:
                log("info", f"Image gen: LoRA adapters — {', '.join(applied_loras)}")
            else:
                log(
                    "warning",
                    "Image gen: LoRA adapters configured but none could be loaded "
                    "(download adapters in Settings → Omega tools).",
                )

        for i, sc in enumerate(scenes):
            ensure_not_cancelled(db, job_id)
            if not isinstance(sc, dict):
                continue
            sn = int(sc.get("scene_number") or i + 1)
            raw_prompt = str(sc.get("image_prompt") or "").strip()
            prompt = prefix + (raw_prompt if raw_prompt else f"cinematic frame for scene {sn}, high detail")
            log("info", f"Image gen: {engine_label} scene {sn} generating ({width}x{height})…")
            log_flush()
            try:
                import sys

                print(
                    f"localgen.image-diffusers: scene {sn} starting diffusion "
                    f"({num_steps} steps, {width}x{height})",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:  # noqa: BLE001
                pass
            out_png = out_dir / f"scene_{sn:02d}.png"
            generate_image_file(
                pipe,
                prompt=prompt,
                negative_prompt=negative if supports_neg else None,
                width=width,
                height=height,
                num_steps=num_steps,
                guidance_scale=guidance_scale,
                seed=42 + sn,
                out_path=out_png,
                supports_negative_prompt=supports_neg,
                cancel_check=lambda: ensure_not_cancelled(db, job_id),
            )
            log("info", f"Image gen: {engine_label} scene {sn} wrote {out_png.name}")
            log_flush()
        if pipe is not None:
            if keep_pipe_warm:
                set_warm_image_pipeline(model_dir, base_repo, pipe, attn_label, model_info)
                log("info", "Image gen: keeping pipeline warm in VRAM (desktop — next image click).")
                pipe = None
            else:
                dispose_sd3_pipeline(pipe, reason="pipeline_images_job_done")
                pipe = None
                log("info", "Image gen: pipeline disposed — VRAM free for TTS.")
                log_flush()
        return f"{engine_label} images → {out_dir}"
    except JobCancelledError:
        keep_pipe_warm = False
        raise
    except Exception as exc:  # noqa: BLE001
        keep_pipe_warm = False
        log("error", f"Image gen ({engine_label}): pipeline failed ({exc}); filling placeholders.")
        for i, sc in enumerate(scenes):
            if isinstance(sc, dict):
                sn = int(sc.get("scene_number") or i + 1)
                _placeholder_png(out_dir / f"scene_{sn:02d}.png", width, height, f"Scene {sn} (fallback)")
        return f"{engine_label} error — placeholders used ({exc})"
    finally:
        try:
            from app.services.pipeline_job_pipes import dispose_job_image_pipe

            dispose_job_image_pipe(job_id)
        except Exception:  # noqa: BLE001
            pass
        log_flush()
        if pipe is not None:
            dispose_sd3_pipeline(pipe, reason="pipeline_image_done")
