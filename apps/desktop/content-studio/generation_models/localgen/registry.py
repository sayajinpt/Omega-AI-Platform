"""Catalogs shared by the Qt studio and the YouTube automation backend."""

from pathlib import Path
from typing import Any

# App-wide defaults when a project leaves TTS / image model unset ("Automatic" in the UI).
DEFAULT_TTS_REPO_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"
DEFAULT_IMAGE_REPO_ID = "cutycat2000/InterDiffusion-Nano"
# Empty = user must pin a model role or install under video/ (auto-discovered at runtime).
DEFAULT_VIDEO_REPO_ID = ""
DEFAULT_TTS_CATALOG_KEY = "Qwen3-TTS-12Hz-0.6B-CustomVoice"
DEFAULT_IMAGE_CATALOG_KEY = "InterDiffusion-Nano"

# Omega Content Studio UI: suggested downloads per modality (user may install any HF diffusers T2V repo).
STUDIO_SUGGESTED_TTS_KEYS: tuple[str, ...] = ("Qwen3-TTS-12Hz-0.6B-CustomVoice",)
STUDIO_SUGGESTED_IMAGE_KEYS: tuple[str, ...] = ("InterDiffusion-Nano",)
STUDIO_SUGGESTED_VIDEO_KEYS: tuple[str, ...] = ("LTX-Video-0.9.5",)

TTS_MODEL_CATALOG: dict[str, dict[str, Any]] = {
    "Qwen3-TTS-12Hz-1.7B-CustomVoice": {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "description": "Custom Voice model with 9 premium timbres",
        "size": "~3.5 GB",
        # Omitted = ``custom_voice`` (``generate_custom_voice`` with named speakers).
        "generation_mode": "custom_voice",
    },
    "Qwen3-TTS-12Hz-1.7B-VoiceDesign": {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "description": "Voice Design - create voices from descriptions",
        "size": "~3.5 GB",
        "generation_mode": "voice_design",
    },
    "Qwen3-TTS-12Hz-0.6B-CustomVoice": {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        "description": "Smaller Custom Voice model (faster, lower quality)",
        "size": "~1.5 GB",
        "generation_mode": "custom_voice",
    },
    "aiseosae / qwenTTS (Vocence bundle)": {
        "id": "aiseosae/qwenTTS",
        "description": (
            "Community Qwen3-TTS snapshot + Vocence miner layout (English). "
            "Uses voice-design synthesis (``generate_voice_design``): timbre follows the "
            "narration-tone instruct plus a prefix derived from your speaker + gender filter "
            "(CustomVoice-style checkpoints use the speaker id directly instead). "
            "License: CC BY-NC-SA 4.0 — check the HF model card before commercial use."
        ),
        "size": "~3–4 GB (same class as Qwen3-TTS 1.7B)",
        "generation_mode": "voice_design",
    },
}


def infer_tts_repo_id_from_model_dir(model_dir: Path) -> str | None:
    """
    Best-effort reverse of ``repo_id.replace('/', '__')`` from a resolved TTS weights path.

    Walks up from ``model_dir`` until the parent folder is named ``tts``, then treats that
    child directory name as the HF-safe id (``org__repo`` → ``org/repo``). Used when the
    project leaves ``hf_tts_repo_id`` unset but weights were auto-discovered — so
    ``voice_design`` vs ``custom_voice`` routing still matches the folder that was found.
    """
    cur = Path(model_dir).resolve()
    for _ in range(12):
        try:
            parent = cur.parent
        except Exception:  # noqa: BLE001
            return None
        if parent.name.lower() == "tts":
            safe = cur.name
            if "__" not in safe:
                return None
            org, sep, rest = safe.partition("__")
            if not org or not rest or sep != "__":
                return None
            return f"{org}/{rest}"
        if cur == parent:
            return None
        cur = parent
    return None


def tts_generation_mode_for_repo(repo_id: str | None) -> str:
    """
    Return ``\"custom_voice\"`` or ``\"voice_design\"`` for a pinned HF ``repo_id``.

    ``custom_voice`` → :meth:`qwen_tts.Qwen3TTSModel.generate_custom_voice` (speaker + instruct).
    ``voice_design`` → :meth:`qwen_tts.Qwen3TTSModel.generate_voice_design` (text + instruct + language),
    as used by ``aiseosae/qwenTTS`` and the official VoiceDesign checkpoint.
    """
    rid = (repo_id or "").strip()
    if not rid:
        return "custom_voice"
    for entry in TTS_MODEL_CATALOG.values():
        if str(entry.get("id") or "").strip() == rid:
            mode = str(entry.get("generation_mode") or "custom_voice").strip().lower()
            if mode in ("voice_design", "voice-design", "voicedesign"):
                return "voice_design"
            return "custom_voice"
    return "custom_voice"

IMAGE_MODEL_CATALOG: dict[str, dict[str, Any]] = {
    "SD3.5 Medium Turbo (Checkpoint)": {
        "id": "tensorart/stable-diffusion-3.5-medium-turbo",
        "description": "Fast SD3.5 Medium with turbo distillation.",
        "size": "~5 GB",
        "type": "checkpoint",
        "engine": "sd3",
        "default_num_steps": 8,
        "default_guidance_scale": 7.0,
        "default_dtype": "float16",
        "supports_negative_prompt": True,
    },
    "SD3.5 Medium + Turbo LoRA": {
        "id": "stabilityai/stable-diffusion-3.5-medium",
        "lora_id": "tensorart/stable-diffusion-3.5-medium-turbo",
        "lora_file": "lora_sd3.5m_turbo_8steps.safetensors",
        "description": "SD3.5 Medium base + TensorArt Turbo LoRA.",
        "size": "~5 GB + ~500 MB",
        "type": "lora",
        "engine": "sd3",
        "default_num_steps": 8,
        "default_guidance_scale": 7.0,
        "default_dtype": "float16",
        "supports_negative_prompt": True,
    },
    "Z-Image-Turbo (sub-second, 16 GB VRAM)": {
        "id": "Tongyi-MAI/Z-Image-Turbo",
        "description": (
            "Distilled Z-Image with ~8 NFEs — sub-second on H800, fits 16 GB VRAM. "
            "Photorealistic + bilingual (EN/CN) text rendering. Use guidance_scale=0."
        ),
        "size": "~6 GB",
        "type": "zimage",
        "engine": "zimage",
        "default_num_steps": 9,
        "default_guidance_scale": 0.0,
        "default_dtype": "bfloat16",
        "supports_negative_prompt": False,
        "low_cpu_mem_usage": False,
    },
    "InterDiffusion-2.5": {
        "id": "cutycat2000/InterDiffusion-2.5",
        "description": (
            "Open text-to-image checkpoint — single-file SDXL safetensors, fp16. "
            "Good for varied artistic styles; ~70-word prompt budget."
        ),
        "size": "~6.94 GB",
        "type": "diffusers_single_file",
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionXLPipeline",
        "single_file_target": "model.safetensors",
        # Single-file SDXL checkpoints don't ship the scheduler / tokenizer / text-encoder
        # config files. The backend pre-fetches them once from this base repo into a local
        # dir (no symlinks) and passes the path as ``config=`` to ``from_single_file``.
        "config_repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
        "default_num_steps": 28,
        "default_guidance_scale": 5.0,
        "default_dtype": "float16",
        "supports_negative_prompt": True,
    },
    "InterDiffusion-Nano": {
        "id": "cutycat2000/InterDiffusion-Nano",
        "description": (
            "Compact SD 1.5 text-to-image — single-file checkpoint, fp16. "
            "Fast and low VRAM; ~70-word prompt budget."
        ),
        "size": "~2.0 GB",
        "type": "diffusers_single_file",
        "engine": "diffusers_single_file",
        "single_file_class": "StableDiffusionPipeline",
        "single_file_target": "model.safetensors",
        "config_repo_id": "runwayml/stable-diffusion-v1-5",
        "default_num_steps": 25,
        "default_guidance_scale": 7.0,
        "default_dtype": "float16",
        "default_width": 512,
        "default_height": 512,
        "supports_negative_prompt": True,
    },
}


def studio_suggested_tts_catalog() -> dict[str, dict[str, Any]]:
    return {k: TTS_MODEL_CATALOG[k] for k in STUDIO_SUGGESTED_TTS_KEYS if k in TTS_MODEL_CATALOG}


def studio_suggested_image_catalog() -> dict[str, dict[str, Any]]:
    return {k: IMAGE_MODEL_CATALOG[k] for k in STUDIO_SUGGESTED_IMAGE_KEYS if k in IMAGE_MODEL_CATALOG}


VIDEO_MODEL_CATALOG: dict[str, dict[str, Any]] = {
    "LTX-Video-0.9.5": {
        "id": "Lightricks/LTX-Video-0.9.5",
        "description": (
            "Lightricks LTX-Video — DiT text-to-video (diffusers). Fast, high-quality motion; "
            "any HF repo with model_index.json under video/ also works."
        ),
        "size": "~8 GB",
        "type": "diffusers_auto",
        "engine": "diffusers_auto",
        "default_height": 480,
        "default_width": 704,
        "default_num_frames": 97,
        "default_num_steps": 30,
        "default_fps": 24,
        "default_guidance_scale": 3.0,
        "default_decode_timestep": 0.05,
        "default_decode_noise_scale": 0.025,
        "default_negative_prompt": (
            "worst quality, inconsistent motion, blurry, jittery, distorted"
        ),
        "default_dtype": "bfloat16",
        "supports_negative_prompt": True,
    },
}


def studio_suggested_video_catalog() -> dict[str, dict[str, Any]]:
    return {k: VIDEO_MODEL_CATALOG[k] for k in STUDIO_SUGGESTED_VIDEO_KEYS if k in VIDEO_MODEL_CATALOG}


def video_model_runtime_defaults(model_info: dict[str, Any] | None) -> dict[str, Any]:
    info: dict[str, Any] = dict(model_info or {})
    frames_raw = info.get("default_num_frames")
    steps_raw = info.get("default_num_steps")
    guide_raw = info.get("default_guidance_scale")
    fps_raw = info.get("default_fps")
    height_raw = info.get("default_height")
    width_raw = info.get("default_width")
    decode_ts = info.get("default_decode_timestep")
    decode_ns = info.get("default_decode_noise_scale")
    return {
        "engine": str(info.get("engine") or "diffusers_auto").lower(),
        "num_frames": int(frames_raw) if frames_raw is not None else 61,
        "num_steps": int(steps_raw) if steps_raw is not None else 30,
        "guidance_scale": float(guide_raw) if guide_raw is not None else 6.0,
        "fps": int(fps_raw) if fps_raw is not None else 15,
        "height": int(height_raw) if height_raw is not None else None,
        "width": int(width_raw) if width_raw is not None else None,
        "decode_timestep": float(decode_ts) if decode_ts is not None else None,
        "decode_noise_scale": float(decode_ns) if decode_ns is not None else None,
        "default_negative_prompt": str(info.get("default_negative_prompt") or "").strip(),
        "dtype": str(info.get("default_dtype") or "bfloat16").lower(),
        "supports_negative_prompt": bool(info.get("supports_negative_prompt", True)),
    }


SPEAKERS: dict[str, dict[str, str]] = {
    "Vivian": {"gender": "Female", "language": "Chinese", "description": "Bright, edgy young female voice"},
    "Serena": {"gender": "Female", "language": "Chinese", "description": "Warm, gentle young female voice"},
    "Uncle_Fu": {"gender": "Male", "language": "Chinese", "description": "Seasoned male voice, low and mellow"},
    "Dylan": {"gender": "Male", "language": "Chinese (Beijing)", "description": "Youthful Beijing male voice"},
    "Eric": {"gender": "Male", "language": "Chinese (Sichuan)", "description": "Lively Chengdu male voice"},
    "Ryan": {"gender": "Male", "language": "English", "description": "Dynamic male voice, strong rhythm"},
    "Aiden": {"gender": "Male", "language": "English", "description": "Sunny American male voice"},
    "Ono_Anna": {"gender": "Female", "language": "Japanese", "description": "Playful Japanese female voice"},
    "Sohee": {"gender": "Female", "language": "Korean", "description": "Warm Korean female voice"},
}

SUPPORTED_LANGUAGES: list[str] = [
    "Auto",
    "Chinese",
    "English",
    "Japanese",
    "Korean",
    "German",
    "French",
    "Russian",
    "Portuguese",
    "Spanish",
    "Italian",
]

def image_model_runtime_defaults(model_info: dict[str, Any] | None) -> dict[str, Any]:
    """
    Return the runtime defaults the inference call should use for a catalog entry.

    Falls back to SD3-style defaults so callers that pass an unknown ``model_info`` still work.
    Uses explicit ``None``-checks for numeric fields so a literal ``0`` (Z-Image guidance) is preserved.
    """
    info: dict[str, Any] = dict(model_info or {})
    steps_raw = info.get("default_num_steps")
    guide_raw = info.get("default_guidance_scale")
    return {
        "engine": str(info.get("engine") or info.get("type") or "sd3").lower(),
        "num_steps": int(steps_raw) if steps_raw is not None else 8,
        "guidance_scale": float(guide_raw) if guide_raw is not None else 7.0,
        "dtype": str(info.get("default_dtype") or "float16").lower(),
        "supports_negative_prompt": bool(info.get("supports_negative_prompt", True)),
        "low_cpu_mem_usage": bool(info.get("low_cpu_mem_usage", True)),
    }


# Art-style presets — pick one per project; the pipeline prepends ``prompt_prefix`` to every
# scene's image prompt and uses ``negative`` to steer away from rival styles (when the engine
# supports negative prompts). ``key`` is what gets stored on ``video_projects.image_style``.
STYLE_PRESETS: dict[str, dict[str, str]] = {
    "Auto": {
        "key": "auto",
        "description": "No style steering — use the scene's raw image_prompt as written.",
        "prompt_prefix": "",
        "negative": "",
    },
    "Photorealistic": {
        "key": "photorealistic",
        "description": "Camera-real lighting, skin pores, lens depth. Good for documentary / news.",
        "prompt_prefix": "photorealistic, highly detailed, 8k, professional photography, natural lighting, ",
        "negative": "cartoon, anime, painting, sketch, illustration, low quality, blurry, plastic, doll-like",
    },
    "Cinematic Film": {
        "key": "cinematic_film",
        "description": "35mm film look, anamorphic lens, moody color grading, shallow depth-of-field.",
        "prompt_prefix": "cinematic film still, 35mm, anamorphic lens, moody color grading, shallow depth of field, film grain, ",
        "negative": "cartoon, anime, flat lighting, low quality, oversharpened, plastic",
    },
    "Studio Photography": {
        "key": "studio_photo",
        "description": "Clean studio softbox lighting, neutral backdrop — product / portrait look.",
        "prompt_prefix": "studio photography, softbox lighting, clean backdrop, sharp focus, color-accurate, ",
        "negative": "harsh shadows, cartoon, painting, low quality, motion blur",
    },
    "Anime": {
        "key": "anime",
        "description": "Modern anime / manga look — clean line art, vibrant flat colors.",
        "prompt_prefix": "anime style, manga illustration, clean line art, vibrant flat colors, dynamic angle, ",
        "negative": "photorealistic, 3d render, realistic, photograph, gritty texture",
    },
    "Studio Ghibli": {
        "key": "ghibli",
        "description": "Hayao Miyazaki / Studio Ghibli storybook hand-painted look. Warm, whimsical.",
        "prompt_prefix": (
            "studio ghibli style, hayao miyazaki inspired, hand-painted animation background, "
            "soft watercolor textures, warm sunlight, whimsical storybook atmosphere, "
        ),
        "negative": "photorealistic, 3d render, harsh outlines, dark gritty, hyperrealism, plastic",
    },
    "3D Pixar / Disney": {
        "key": "pixar_3d",
        "description": "Stylized 3D render — big eyes, soft shading, family-friendly hero shot.",
        "prompt_prefix": (
            "stylized 3d animation, pixar-disney inspired, soft subsurface shading, expressive "
            "character, cinematic lighting, polished render, "
        ),
        "negative": "photorealistic, anime line art, gritty, dark, low poly, flat 2d",
    },
    "Comic Book / Graphic Novel": {
        "key": "comic_book",
        "description": "Bold ink outlines, halftone shading, dramatic panel composition.",
        "prompt_prefix": "comic book illustration, bold ink outlines, halftone shading, dramatic panel composition, vivid colors, ",
        "negative": "photorealistic, 3d render, soft blur, watercolor",
    },
    "Watercolor": {
        "key": "watercolor",
        "description": "Soft wet-on-wet watercolor — gentle edges, paper texture.",
        "prompt_prefix": "watercolor painting, soft wet-on-wet bleeds, paper texture, gentle edges, pastel palette, ",
        "negative": "photorealistic, sharp digital edges, 3d render, harsh contrast",
    },
    "Oil Painting": {
        "key": "oil_painting",
        "description": "Thick textured brushstrokes, classical fine-art look.",
        "prompt_prefix": "oil painting, classical fine art, textured brushstrokes, rich impasto, masterpiece composition, ",
        "negative": "photograph, digital art, 3d render, clean vector",
    },
    "Pencil Sketch": {
        "key": "pencil_sketch",
        "description": "Hand-drawn graphite — cross-hatching, paper grain, monochrome.",
        "prompt_prefix": "detailed pencil sketch, graphite, cross-hatching, paper grain, monochrome, hand drawn, ",
        "negative": "color, photorealistic, 3d render, painting",
    },
    "Digital Art / Concept Art": {
        "key": "digital_art",
        "description": "Polished concept art — ArtStation-style, painterly lighting.",
        "prompt_prefix": "digital concept art, painterly lighting, trending on artstation, intricate detail, dramatic composition, ",
        "negative": "photograph, realistic, blurry, low quality",
    },
    "Cyberpunk": {
        "key": "cyberpunk",
        "description": "Neon-drenched dystopia — rain, holograms, chrome, Hong Kong night.",
        "prompt_prefix": "cyberpunk aesthetic, neon-drenched, rain-slick streets, holographic signs, chrome reflections, sci-fi dystopia, ",
        "negative": "medieval, pastoral, natural landscape, daylight countryside",
    },
    "Dark Fantasy": {
        "key": "dark_fantasy",
        "description": "Grimdark fantasy — heavy shadows, ornate armor, gothic atmosphere.",
        "prompt_prefix": "dark fantasy art, grimdark mood, heavy chiaroscuro shadows, ornate armor and runes, gothic atmosphere, ",
        "negative": "bright pastel, cute cartoon, modern, photorealistic snapshot",
    },
    "Vaporwave / Retro 80s": {
        "key": "vaporwave",
        "description": "Pink-and-cyan 80s retro — chrome busts, palm grids, VHS scanlines.",
        "prompt_prefix": "vaporwave aesthetic, 1980s retro, pink and cyan gradients, chrome busts, palm tree grid, vhs scanlines, ",
        "negative": "photorealistic, gritty realism, medieval, natural daylight",
    },
    "Film Noir": {
        "key": "film_noir",
        "description": "1940s black-and-white noir — venetian-blind shadows, hard rim light.",
        "prompt_prefix": "1940s film noir, black and white, venetian blind shadows, hard rim lighting, smoky atmosphere, ",
        "negative": "color, modern, anime, 3d render",
    },
    "Low-Poly / Stylized 3D": {
        "key": "low_poly",
        "description": "Flat-shaded low-poly geometry — minimal, modern indie-game look.",
        "prompt_prefix": "low poly 3d, flat shaded geometry, minimal palette, isometric, indie game aesthetic, ",
        "negative": "photorealistic, oil painting, hand drawn, hyperdetail",
    },
    "Pixel Art": {
        "key": "pixel_art",
        "description": "Crisp 16-bit pixel art — limited palette, dithering, tile-based.",
        "prompt_prefix": "16-bit pixel art, crisp pixels, limited palette, dithering, tile-based composition, ",
        "negative": "photorealistic, soft gradient, 3d render, smooth lines",
    },
    "Storyboard Sketch": {
        "key": "storyboard",
        "description": "Quick storyboard frames — loose line art, simple values, annotation feel.",
        "prompt_prefix": "storyboard sketch, loose line art, quick value blocks, animation pre-production, ",
        "negative": "polished, photorealistic, finished render",
    },
}


def style_preset_keys() -> list[str]:
    """Stable list of preset keys for DB / UI persistence (ordered like ``STYLE_PRESETS``)."""
    return [str(v.get("key") or "").strip().lower() for v in STYLE_PRESETS.values() if v.get("key")]


def style_preset_by_key(key: str | None) -> dict[str, str] | None:
    """Look up a style entry by its stored ``key`` (case-insensitive). ``None`` if unknown."""
    k = (key or "").strip().lower()
    if not k:
        return None
    for v in STYLE_PRESETS.values():
        if str(v.get("key") or "").strip().lower() == k:
            return v
    return None
