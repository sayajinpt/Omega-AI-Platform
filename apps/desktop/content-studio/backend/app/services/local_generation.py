"""Bridge to the `localgen` package (generation_models folder) for local TTS / SD3."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.config import settings


def data_root() -> Path:
    return Path(settings.generation_models_data_dir).expanduser().resolve()


def tts_download_dir(repo_id: str) -> Path:
    safe = repo_id.replace("/", "__")
    return data_root() / "tts" / safe


def image_download_dir(repo_id: str) -> Path:
    safe = repo_id.replace("/", "__")
    return data_root() / "image" / safe


def video_download_dir(repo_id: str) -> Path:
    safe = repo_id.replace("/", "__")
    return data_root() / "video" / safe


def download_hf_repo(repo_id: str, dest: Path) -> Path:
    from localgen.downloads import download_snapshot

    return download_snapshot(repo_id, dest)


def synthesize_scene_wav(
    model_dir: Path,
    text: str,
    out_wav: Path,
    *,
    language: str,
    speaker: str,
    instruct: str | None,
    use_gpu: bool = True,
    use_flash: bool | None = None,
    hf_tts_repo_id: str | None = None,
    voice_gender: str | None = None,
) -> None:
    from localgen.attention_backend import should_prefer_flash_attention
    from localgen.engines import synthesize_qwen_wav

    if use_flash is None:
        use_flash = should_prefer_flash_attention(use_gpu=use_gpu)

    synthesize_qwen_wav(
        model_dir,
        text,
        out_wav,
        language=language,
        speaker=speaker,
        instruct=instruct,
        use_gpu=use_gpu,
        use_flash_attention=use_flash,
        hf_repo_id=hf_tts_repo_id,
        voice_gender=voice_gender,
    )


def catalog_tts_models() -> dict[str, dict[str, Any]]:
    from localgen.registry import TTS_MODEL_CATALOG

    return TTS_MODEL_CATALOG


def catalog_image_models() -> dict[str, dict[str, Any]]:
    from localgen.registry import IMAGE_MODEL_CATALOG

    return IMAGE_MODEL_CATALOG


def catalog_video_models() -> dict[str, dict[str, Any]]:
    from localgen.registry import VIDEO_MODEL_CATALOG

    return VIDEO_MODEL_CATALOG
