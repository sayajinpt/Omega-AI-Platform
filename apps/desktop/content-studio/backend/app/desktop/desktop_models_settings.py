"""Persist desktop-only paths (e.g. Hugging Face weights root) next to the SQLite file."""

from __future__ import annotations

import json
from pathlib import Path


def _backend_root() -> Path:
    return Path(__file__).resolve().parents[1]


def desktop_ui_settings_path() -> Path:
    data = _backend_root() / "data"
    data.mkdir(parents=True, exist_ok=True)
    return data / "desktop_ui.json"


def load_saved_models_data_dir() -> str | None:
    from localgen.paths import _is_under_omega

    p = desktop_ui_settings_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = (data.get("generation_models_data_dir") or "").strip()
    if not raw:
        return None
    resolved = Path(raw).expanduser().resolve()
    if not _is_under_omega(resolved):
        return None
    return str(resolved)


def save_models_data_dir(path: str) -> None:
    from localgen.paths import _is_under_omega

    resolved = Path(path).expanduser().resolve()
    if not _is_under_omega(resolved):
        raise ValueError("Generation models path must be inside the Omega home folder (.omega).")
    p = desktop_ui_settings_path()
    prev: dict = {}
    if p.is_file():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    prev["generation_models_data_dir"] = str(resolved)
    p.write_text(json.dumps(prev, indent=2), encoding="utf-8")


_HF_KEY = "hf_token"


def load_saved_hf_token() -> str | None:
    p = desktop_ui_settings_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = (data.get(_HF_KEY) or "").strip()
    return raw or None


def save_hf_token(token: str) -> None:
    p = desktop_ui_settings_path()
    prev: dict = {}
    if p.is_file():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    t = token.strip()
    if t:
        prev[_HF_KEY] = t
    else:
        prev.pop(_HF_KEY, None)
    p.write_text(json.dumps(prev, indent=2), encoding="utf-8")


def clear_saved_hf_token() -> None:
    save_hf_token("")


def apply_saved_hf_token_to_environ() -> None:
    """If the process has no HF token in the environment, inject a token saved by the desktop."""
    import os

    if (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip():
        return
    saved = load_saved_hf_token()
    if saved:
        os.environ["HF_TOKEN"] = saved


_TAVILY_KEY = "tavily_api_key"


def load_saved_tavily_key() -> str | None:
    p = desktop_ui_settings_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = (data.get(_TAVILY_KEY) or "").strip()
    return raw or None


def save_tavily_key(key: str) -> None:
    p = desktop_ui_settings_path()
    prev: dict = {}
    if p.is_file():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    t = key.strip()
    if t:
        prev[_TAVILY_KEY] = t
    else:
        prev.pop(_TAVILY_KEY, None)
    p.write_text(json.dumps(prev, indent=2), encoding="utf-8")


def clear_saved_tavily_key() -> None:
    save_tavily_key("")


def apply_saved_tavily_to_environ() -> None:
    """If Tavily is not already in the environment, inject a key saved by the desktop."""
    import os

    if (os.environ.get("TAVILY_API_KEY") or "").strip():
        return
    saved = load_saved_tavily_key()
    if saved:
        os.environ["TAVILY_API_KEY"] = saved


_AGENT_WEBHOOK_KEY = "agent_webhook_url"


def load_saved_agent_webhook_url() -> str | None:
    p = desktop_ui_settings_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    raw = (data.get(_AGENT_WEBHOOK_KEY) or "").strip()
    return raw or None


def save_agent_webhook_url(url: str) -> None:
    p = desktop_ui_settings_path()
    prev: dict = {}
    if p.is_file():
        try:
            prev = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prev = {}
    u = url.strip()
    if u:
        prev[_AGENT_WEBHOOK_KEY] = u
    else:
        prev.pop(_AGENT_WEBHOOK_KEY, None)
    p.write_text(json.dumps(prev, indent=2), encoding="utf-8")


def clear_saved_agent_webhook_url() -> None:
    save_agent_webhook_url("")


def apply_saved_agent_webhook_to_environ() -> None:
    import os

    if (os.environ.get("AGENT_WEBHOOK_URL") or "").strip():
        return
    saved = load_saved_agent_webhook_url()
    if saved:
        os.environ["AGENT_WEBHOOK_URL"] = saved
