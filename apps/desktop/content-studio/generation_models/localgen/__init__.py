from localgen.downloads import download_snapshot
from localgen.hf_auth import hf_token_argument
from localgen.gpu_runtime import (
    active_gpu_kind,
    after_use,
    before_load,
    dispose_sd3_pipeline,
    set_event_sink,
    status_line,
    unload_all,
)
from localgen.paths import get_models_root, repo_folder_name
from localgen.registry import (
    DEFAULT_IMAGE_REPO_ID,
    DEFAULT_TTS_REPO_ID,
    IMAGE_MODEL_CATALOG,
    SPEAKERS,
    STYLE_PRESETS,
    SUPPORTED_LANGUAGES,
    TTS_MODEL_CATALOG,
    style_preset_by_key,
    style_preset_keys,
)

__all__ = [
    "TTS_MODEL_CATALOG",
    "IMAGE_MODEL_CATALOG",
    "DEFAULT_TTS_REPO_ID",
    "DEFAULT_IMAGE_REPO_ID",
    "SPEAKERS",
    "SUPPORTED_LANGUAGES",
    "STYLE_PRESETS",
    "style_preset_by_key",
    "style_preset_keys",
    "download_snapshot",
    "hf_token_argument",
    "get_models_root",
    "repo_folder_name",
    "before_load",
    "after_use",
    "unload_all",
    "dispose_sd3_pipeline",
    "active_gpu_kind",
    "status_line",
    "set_event_sink",
]
