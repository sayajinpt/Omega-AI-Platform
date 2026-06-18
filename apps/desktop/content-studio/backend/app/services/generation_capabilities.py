"""
Runtime capability discovery for user-installed Hugging Face generation models.

Catalog entries (``localgen/registry.py``) are optional overlays — truth comes from
what is on disk plus which backend family Omega can drive.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from app.services.model_folder_discovery import (
    infer_image_model_info_from_dir,
    infer_video_model_info_from_dir,
    resolve_image_pack_dir,
    resolve_video_pack_dir,
    resolve_hf_style_load_path,
    _read_model_index_class,
    find_diffusers_root,
)
from localgen.paths import get_models_root
from localgen.registry import (
    IMAGE_MODEL_CATALOG,
    SPEAKERS,
    SUPPORTED_LANGUAGES,
    TTS_MODEL_CATALOG,
    VIDEO_MODEL_CATALOG,
    image_model_runtime_defaults,
    tts_generation_mode_for_repo,
    video_model_runtime_defaults,
)

Modality = Literal["tts", "image", "video"]


def _pipeline_briefing_controls() -> list[dict[str, Any]]:
    """Script / pipeline briefing knobs — not tied to a single HF weight file."""
    return [
        _control(
            "max_duration_seconds",
            "enum",
            "Target length",
            default=60,
            values=["15", "20", "30", "60", "120", "180"],
            description="Target video duration for script scene budgeting.",
        ),
    ]


def _with_briefing_controls(controls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    existing = {str(c.get("id") or "") for c in controls}
    out = list(controls)
    for ctrl in _pipeline_briefing_controls():
        if ctrl["id"] not in existing:
            out.append(ctrl)
    return out


def _control(
    control_id: str,
    control_type: str,
    label: str,
    *,
    default: Any = None,
    min_value: float | int | None = None,
    max_value: float | int | None = None,
    values: list[str] | None = None,
    description: str = "",
    advanced: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": control_id,
        "type": control_type,
        "label": label,
    }
    if default is not None:
        out["default"] = default
    if min_value is not None:
        out["min"] = min_value
    if max_value is not None:
        out["max"] = max_value
    if values is not None:
        out["values"] = values
    if description:
        out["description"] = description
    if advanced:
        out["advanced"] = True
    return out


def _catalog_entry(modality: Modality, repo_id: str) -> dict[str, Any] | None:
    rid = repo_id.strip()
    if not rid:
        return None
    catalog = {
        "tts": TTS_MODEL_CATALOG,
        "image": IMAGE_MODEL_CATALOG,
        "video": VIDEO_MODEL_CATALOG,
    }[modality]
    for meta in catalog.values():
        if str(meta.get("id") or "").strip() == rid:
            return dict(meta)
    return None


def _resolve_tts_pack(repo_id: str, gen_root: Path) -> tuple[Path | None, str]:
    """Locate weights for the requested repo only (no fallback to another installed TTS)."""
    rid = repo_id.strip()
    if not rid:
        return None, ""
    base = gen_root / "tts" / rid.replace("/", "__")
    resolved = resolve_hf_style_load_path(base)
    if resolved is not None:
        return resolved, f"tts ({base})"
    parent = gen_root.parent
    if parent.is_dir():
        leaf = rid.split("/")[-1]
        for candidate in (parent / leaf, parent / rid.replace("/", "__")):
            resolved = resolve_hf_style_load_path(candidate)
            if resolved is not None:
                return resolved, f"models dir ({candidate})"
    return None, ""


def _resolve_pack(modality: Modality, repo_id: str, gen_root: Path) -> tuple[Path | None, str]:
    rid = repo_id.strip()
    if modality == "image":
        return resolve_image_pack_dir(rid, gen_root)
    if modality == "video":
        return resolve_video_pack_dir(rid, gen_root)
    return _resolve_tts_pack(rid, gen_root)


def _detect_tts_family(pack_dir: Path | None, repo_id: str) -> tuple[str, str, bool]:
    """Return ``(family, generation_mode, backend_supported)`` via ``localgen.tts_registry``."""
    from localgen.tts_registry import probe_tts_backend

    mode = tts_generation_mode_for_repo(repo_id)
    info = probe_tts_backend(pack_dir, repo_id)
    return info.family, info.generation_mode or mode, info.backend_supported


def _piper_tts_controls() -> list[dict[str, Any]]:
    return [
        _control(
            "language",
            "enum",
            "Language code",
            default="en",
            values=["en", "es", "fr", "de", "pt", "it"],
            description="ISO-style language passed to Piper (model-dependent).",
        ),
    ]


def _xtts_tts_controls() -> list[dict[str, Any]]:
    return [
        _control(
            "language",
            "enum",
            "Language code",
            default="en",
            values=["en", "es", "fr", "de", "pt", "it", "pl", "tr", "ru", "zh-cn"],
            description="XTTS v2 language code.",
        ),
        _control(
            "speaker",
            "text",
            "Speaker reference",
            description="Optional speaker wav path or built-in speaker id when supported.",
        ),
        _control(
            "narration_speed",
            "instruct_enum",
            "Speech speed",
            default="normal",
            values=["normal", "slow", "very_slow", "fast", "very_fast"],
            description="Mapped into instruct when using Qwen-style steering on hybrid flows.",
        ),
    ]


def _tts_controls_for_family(family: str, generation_mode: str) -> list[dict[str, Any]]:
    if family in ("qwen3_tts_custom_voice", "qwen3_tts_voice_design"):
        return _qwen_tts_controls(generation_mode)
    if family == "piper":
        return _piper_tts_controls()
    if family == "xtts":
        return _xtts_tts_controls()
    return []


def _qwen_tts_controls(generation_mode: str) -> list[dict[str, Any]]:
    langs = [x for x in SUPPORTED_LANGUAGES if x != "Auto"]
    speed_values = ["normal", "slow", "very_slow", "fast", "very_fast"]
    controls: list[dict[str, Any]] = [
        _control(
            "language",
            "enum",
            "Narration language",
            default="English",
            values=langs,
            description="Passed to the Qwen3-TTS language argument.",
        ),
        _control(
            "instruct",
            "text",
            "Voice direction",
            description="Natural-language prosody, emotion, and pacing (Qwen instruct).",
        ),
        _control(
            "narration_speed",
            "instruct_enum",
            "Speech speed",
            default="normal",
            values=speed_values,
            description="Mapped into instruct text — Qwen has no numeric speed parameter.",
        ),
        _control(
            "voice_gender",
            "enum",
            "Voice gender filter",
            default="any",
            values=["any", "male", "female"],
            description="Strongest effect on VoiceDesign checkpoints; CustomVoice uses speaker presets.",
        ),
    ]
    if generation_mode == "custom_voice":
        controls.insert(
            0,
            _control(
                "speaker",
                "enum",
                "Speaker preset",
                default="Ryan",
                values=sorted(SPEAKERS.keys()),
                description="Named Qwen3 CustomVoice timbre.",
            ),
        )
    else:
        controls.insert(
            0,
            _control(
                "speaker",
                "enum",
                "Character preset",
                default="Ryan",
                values=sorted(SPEAKERS.keys()),
                description="Folded into instruct for VoiceDesign — not a native API id.",
            ),
        )
    return controls


def _image_family(model_info: dict[str, Any], pipeline_class: str) -> str:
    engine = str(model_info.get("engine") or "").lower()
    cls = pipeline_class.lower()
    rid = str(model_info.get("id") or "").lower()
    if engine == "zimage" or "zimage" in cls or "z-image" in rid:
        return "zimage"
    if engine == "sd3" or "stable diffusion 3" in cls or "sd3" in cls:
        return "sd3"
    if "flux" in cls or "flux" in rid:
        return "flux"
    if engine == "diffusers_single_file":
        if "xl" in cls or "xl" in rid:
            return "sdxl_single_file"
        return "sd15_single_file"
    return "diffusers_image"


def _image_controls(model_info: dict[str, Any], family: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    defaults = image_model_runtime_defaults(model_info)
    constraints: dict[str, Any] = {
        "supports_negative_prompt": bool(defaults.get("supports_negative_prompt", True)),
        "supports_lora": bool(model_info.get("supports_adapters", family != "zimage")),
    }
    if family == "zimage":
        constraints["supports_negative_prompt"] = False
        constraints["guidance_scale_fixed"] = 0.0

    steps_default = int(model_info.get("default_num_steps") or defaults["num_steps"])
    cfg_default = float(model_info.get("default_guidance_scale") or defaults["guidance_scale"])
    width_default = int(model_info.get("default_width") or 1024)
    height_default = int(model_info.get("default_height") or 1024)

    controls: list[dict[str, Any]] = [
        _control("prompt", "text", "Prompt"),
        _control("width", "int", "Width", default=width_default, min_value=256, max_value=2048),
        _control("height", "int", "Height", default=height_default, min_value=256, max_value=2048),
        _control(
            "num_inference_steps",
            "int",
            "Inference steps",
            default=steps_default,
            min_value=1,
            max_value=80,
        ),
        _control(
            "guidance_scale",
            "float",
            "Guidance scale (CFG)",
            default=cfg_default,
            min_value=0.0,
            max_value=20.0,
            description="Must be 0 for Z-Image turbo models.",
        ),
        _control("seed", "int", "Seed", default=42, min_value=0, max_value=2_147_483_647, advanced=True),
        _control(
            "style_preset",
            "enum",
            "Visual style preset",
            default="auto",
            values=[
                "auto",
                "photorealistic",
                "cinematic_film",
                "anime",
                "digital_art",
            ],
            description="Omega prepends style prefix / negative from STYLE_PRESETS.",
        ),
    ]
    if constraints["supports_negative_prompt"]:
        controls.insert(1, _control("negative_prompt", "text", "Negative prompt"))
    if constraints.get("supports_lora"):
        controls.append(
            _control(
                "lora_adapters",
                "adapter_list",
                "LoRA adapters",
                advanced=True,
                description="Repo + file + scale; SD3/SDXL families.",
            )
        )
    return controls, constraints


def _video_family(model_info: dict[str, Any], pipeline_class: str) -> str:
    cls = pipeline_class.lower()
    rid = str(model_info.get("id") or "").lower()
    if "ltx" in cls or "ltx" in rid:
        return "ltx_video"
    if "cogvideo" in cls or "cogvideox" in cls:
        return "cogvideox"
    if "svd" in cls or "stablevideo" in cls:
        return "stable_video_diffusion"
    return "diffusers_video"


def _video_controls(model_info: dict[str, Any], family: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    defaults = video_model_runtime_defaults(model_info)
    constraints: dict[str, Any] = {
        "supports_negative_prompt": bool(defaults.get("supports_negative_prompt", True)),
    }
    if family == "ltx_video":
        constraints["supports_decode_timestep"] = True

    controls: list[dict[str, Any]] = [
        _control("prompt", "text", "Video prompt"),
        _control(
            "num_frames",
            "int",
            "Frame count",
            default=int(defaults["num_frames"]),
            min_value=8,
            max_value=256,
            description="Clip length ≈ num_frames / fps.",
        ),
        _control(
            "fps",
            "int",
            "Frame rate",
            default=int(defaults["fps"]),
            min_value=8,
            max_value=60,
        ),
        _control(
            "num_inference_steps",
            "int",
            "Inference steps",
            default=int(defaults["num_steps"]),
            min_value=1,
            max_value=80,
        ),
        _control(
            "guidance_scale",
            "float",
            "Guidance scale",
            default=float(defaults["guidance_scale"]),
            min_value=0.0,
            max_value=20.0,
            advanced=True,
        ),
        _control("width", "int", "Width", default=int(defaults.get("width") or 704), min_value=256, max_value=1280),
        _control("height", "int", "Height", default=int(defaults.get("height") or 480), min_value=256, max_value=1280),
        _control("seed", "int", "Seed", default=42, advanced=True),
    ]
    if constraints["supports_negative_prompt"]:
        controls.insert(1, _control("negative_prompt", "text", "Negative prompt"))
    if family == "ltx_video":
        controls.extend(
            [
                _control(
                    "decode_timestep",
                    "float",
                    "Decode timestep",
                    default=float(model_info.get("default_decode_timestep") or 0.05),
                    min_value=0.0,
                    max_value=1.0,
                    advanced=True,
                ),
                _control(
                    "decode_noise_scale",
                    "float",
                    "Decode noise scale",
                    default=float(model_info.get("default_decode_noise_scale") or 0.025),
                    min_value=0.0,
                    max_value=1.0,
                    advanced=True,
                ),
            ]
        )
    return controls, constraints


def probe_generation_capabilities(
    modality: Modality,
    repo_id: str,
    *,
    gen_root: Path | None = None,
) -> dict[str, Any]:
    """
    Describe controls and constraints for a pinned HF repo without loading full weights.

    Used by settings UI, briefing cards, and orchestrators — independent of developer test models.
    """
    rid = (repo_id or "").strip()
    root = gen_root or get_models_root()
    pack_dir, origin = _resolve_pack(modality, rid, root)
    on_disk = pack_dir is not None
    catalog = _catalog_entry(modality, rid)

    pipeline_class = ""
    if pack_dir is not None:
        load_root = find_diffusers_root(pack_dir) or pack_dir
        pipeline_class = _read_model_index_class(load_root) or ""

    if modality == "tts":
        from localgen.tts_registry import probe_tts_backend

        info = probe_tts_backend(pack_dir, rid)
        family = info.family
        generation_mode = info.generation_mode or tts_generation_mode_for_repo(rid)
        supported = info.backend_supported
        controls = _with_briefing_controls(
            _tts_controls_for_family(family, generation_mode) if supported else []
        )
        engine = info.engine if supported else "unsupported"
        return {
            "modality": modality,
            "repo_id": rid,
            "on_disk": on_disk,
            "pack_origin": origin,
            "family": family,
            "engine": engine,
            "generation_mode": generation_mode,
            "pipeline_class": pipeline_class or None,
            "backend_supported": supported,
            "constraints": {},
            "defaults": {},
            "controls": controls,
            "unsupported_reason": info.unsupported_reason
            if not supported
            else None,
            "catalog_overlay": catalog,
        }

    if modality == "image":
        model_info = dict(catalog or {})
        if pack_dir is not None:
            inferred = infer_image_model_info_from_dir(pack_dir, rid or "discovered")
            for key, val in inferred.items():
                model_info.setdefault(key, val)
        if not model_info:
            model_info = {"id": rid, "engine": "diffusers_auto"}
        family = _image_family(model_info, pipeline_class)
        controls, constraints = _image_controls(model_info, family)
        controls = _with_briefing_controls(controls)
        runtime = image_model_runtime_defaults(model_info)
        return {
            "modality": modality,
            "repo_id": rid,
            "on_disk": on_disk,
            "pack_origin": origin,
            "family": family,
            "engine": str(model_info.get("engine") or "diffusers_auto"),
            "generation_mode": None,
            "pipeline_class": pipeline_class or model_info.get("single_file_class") or None,
            "backend_supported": on_disk or bool(catalog),
            "constraints": constraints,
            "defaults": {
                "num_inference_steps": runtime["num_steps"],
                "guidance_scale": runtime["guidance_scale"],
            },
            "controls": controls,
            "unsupported_reason": None if on_disk or catalog else "Image weights not found on disk.",
            "catalog_overlay": catalog,
        }

    # video
    model_info = dict(catalog or {})
    if pack_dir is not None:
        inferred = infer_video_model_info_from_dir(pack_dir, rid or "discovered")
        for key, val in inferred.items():
            model_info.setdefault(key, val)
    if not model_info:
        model_info = {"id": rid, "engine": "diffusers_auto"}
    family = _video_family(model_info, pipeline_class)
    controls, constraints = _video_controls(model_info, family)
    controls = _with_briefing_controls(controls)
    runtime = video_model_runtime_defaults(model_info)
    return {
        "modality": modality,
        "repo_id": rid,
        "on_disk": on_disk,
        "pack_origin": origin,
        "family": family,
        "engine": str(model_info.get("engine") or "diffusers_auto"),
        "generation_mode": None,
        "pipeline_class": pipeline_class or None,
        "backend_supported": on_disk or bool(catalog),
        "constraints": constraints,
        "defaults": {
            "num_frames": runtime["num_frames"],
            "num_inference_steps": runtime["num_steps"],
            "fps": runtime["fps"],
            "guidance_scale": runtime["guidance_scale"],
        },
        "controls": controls,
        "unsupported_reason": None if on_disk or catalog else "Video weights not found on disk.",
        "catalog_overlay": catalog,
    }
