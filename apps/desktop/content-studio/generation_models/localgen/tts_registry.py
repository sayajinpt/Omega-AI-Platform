"""
Pluggable TTS backends for Content Studio (Qwen3, Piper ONNX, Coqui XTTS).

Family detection is shared with ``generation_capabilities``; synthesis goes through
:class:`TtsSession` so pipeline code stays model-agnostic.
"""

from __future__ import annotations

import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

TtsFamily = Literal["qwen3_tts_custom_voice", "qwen3_tts_voice_design", "piper", "xtts", "unknown_tts"]


@dataclass
class TtsBackendInfo:
    family: str
    engine: str
    generation_mode: str | None
    backend_supported: bool
    unsupported_reason: str | None = None


@dataclass
class TtsSynthesisParams:
    language: str = "English"
    speaker: str = "Ryan"
    instruct: str | None = None
    voice_gender: str = "any"
    hf_repo_id: str | None = None
    generation_mode: str | None = None


@dataclass
class TtsSession:
    """Loaded TTS handle with uniform per-scene synthesis."""

    family: str
    engine: str
    attention_label: str = ""
    _model: Any = field(repr=False, default=None)
    _dispose: Callable[[], None] | None = field(repr=False, default=None)
    _synthesize: Callable[[str, Path, TtsSynthesisParams], None] | None = field(
        repr=False, default=None
    )

    def synthesize(self, text: str, out_path: Path, params: TtsSynthesisParams) -> None:
        if self._synthesize is None:
            raise RuntimeError(f"TTS session for {self.family} has no synthesize hook")
        self._synthesize(text, Path(out_path), params)

    def dispose(self) -> None:
        if self._dispose is not None:
            self._dispose()


def _find_piper_onnx(pack_dir: Path | None) -> Path | None:
    if pack_dir is None:
        return None
    best: Path | None = None
    best_size = 0
    for onnx in pack_dir.rglob("*.onnx"):
        try:
            size = onnx.stat().st_size
        except OSError:
            continue
        if size > best_size:
            best, best_size = onnx, size
    return best if best_size > 4096 else None


def _xtts_signals(pack_dir: Path | None, repo_id: str) -> bool:
    rid = (repo_id or "").strip().lower()
    if "xtts" in rid or "coqui" in rid:
        return True
    if pack_dir is None:
        return False
    for name in ("config.json", "model.pth", "vocab.json"):
        p = pack_dir / name
        if not p.is_file():
            continue
        try:
            blob = p.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            blob = p.name.lower()
        if "xtts" in blob or (name == "config.json" and "xtts" in blob):
            return True
    return any(pack_dir.rglob("model.pth"))


def _piper_optional_available() -> bool:
    try:
        import piper  # noqa: F401

        return True
    except ImportError:
        return False


def _xtts_optional_available() -> bool:
    try:
        from TTS.api import TTS  # noqa: F401

        return True
    except ImportError:
        return False


def _qwen_optional_available() -> bool:
    try:
        import qwen_tts  # noqa: F401

        return True
    except ImportError:
        return False


def probe_tts_backend(pack_dir: Path | None, repo_id: str) -> TtsBackendInfo:
    """Disk + optional-deps probe — shared by capability API and render pipeline."""
    from localgen.registry import TTS_MODEL_CATALOG, tts_generation_mode_for_repo

    rid = (repo_id or "").strip()
    mode = tts_generation_mode_for_repo(rid)

    catalog_hit = any(str(meta.get("id") or "").strip() == rid for meta in TTS_MODEL_CATALOG.values())

    # Qwen3
    qwen_hit = False
    rid_l = rid.lower()
    qwen_signals = (
        "qwen3-tts" in rid_l,
        "qwen/qwen3-tts" in rid_l,
        rid_l.endswith("/qwentts"),
        "qwentts" in rid_l,
        catalog_hit,
    )
    if pack_dir is not None:
        blob = str(pack_dir).lower()
        qwen_signals = (*qwen_signals, "qwen3-tts" in blob, "qwen_tts" in blob)
        for cfg_name in ("config.json", "preprocessor_config.json"):
            cfg = pack_dir / cfg_name
            if cfg.is_file():
                try:
                    text = cfg.read_text(encoding="utf-8", errors="ignore").lower()
                    if "qwen" in text and "tts" in text:
                        qwen_hit = True
                except OSError:
                    pass
    if any(qwen_signals) or qwen_hit or catalog_hit:
        family: TtsFamily = (
            "qwen3_tts_custom_voice" if mode == "custom_voice" else "qwen3_tts_voice_design"
        )
        if not _qwen_optional_available():
            return TtsBackendInfo(
                family=family,
                engine="qwen3_tts",
                generation_mode=mode,
                backend_supported=False,
                unsupported_reason=(
                    "Qwen3-TTS weights detected but the qwen-tts Python package is not installed. "
                    "Run Content Studio environment setup."
                ),
            )
        return TtsBackendInfo(
            family=family,
            engine="qwen3_tts",
            generation_mode=mode,
            backend_supported=True,
        )

    # Piper ONNX
    piper_onnx = _find_piper_onnx(pack_dir)
    if piper_onnx is not None or "piper" in rid_l:
        if piper_onnx is None and pack_dir is None:
            return TtsBackendInfo(
                family="piper",
                engine="piper_onnx",
                generation_mode=None,
                backend_supported=False,
                unsupported_reason="Piper model not found on disk.",
            )
        if not _piper_optional_available():
            return TtsBackendInfo(
                family="piper",
                engine="piper_onnx",
                generation_mode=None,
                backend_supported=False,
                unsupported_reason=(
                    "Piper ONNX weights detected but piper-tts is not installed "
                    "(pip install piper-tts)."
                ),
            )
        return TtsBackendInfo(
            family="piper",
            engine="piper_onnx",
            generation_mode=None,
            backend_supported=piper_onnx is not None,
            unsupported_reason=None if piper_onnx is not None else "Piper ONNX file not found.",
        )

    # Coqui XTTS
    if _xtts_signals(pack_dir, rid):
        if not _xtts_optional_available():
            return TtsBackendInfo(
                family="xtts",
                engine="coqui_xtts",
                generation_mode=None,
                backend_supported=False,
                unsupported_reason=(
                    "XTTS weights or repo id detected but Coqui TTS is not installed "
                    "(pip install TTS)."
                ),
            )
        on_disk = pack_dir is not None and (
            (pack_dir / "model.pth").is_file() or any(pack_dir.rglob("*.pth"))
        )
        return TtsBackendInfo(
            family="xtts",
            engine="coqui_xtts",
            generation_mode=None,
            backend_supported=on_disk or catalog_hit,
            unsupported_reason=None if on_disk else "XTTS weights not found on disk.",
        )

    return TtsBackendInfo(
        family="unknown_tts",
        engine="unsupported",
        generation_mode=mode,
        backend_supported=False,
        unsupported_reason=(
            "This TTS repo is not a supported family yet. Omega drives Qwen3-TTS, Piper ONNX, "
            "and Coqui XTTS when optional packages are installed."
        ),
    )


def _load_qwen_session(model_dir: Path, *, use_gpu: bool, use_flash: bool) -> TtsSession:
    from localgen.engines import generate_qwen_speech, load_qwen_tts_model
    from localgen.gpu_runtime import dispose_qwen_tts_model

    model, label = load_qwen_tts_model(
        model_dir, use_gpu=use_gpu, use_flash_attention=use_flash
    )

    def _syn(text: str, out_path: Path, params: TtsSynthesisParams) -> None:
        generate_qwen_speech(
            model,
            text,
            out_path,
            language=params.language,
            speaker=params.speaker,
            instruct=params.instruct,
            hf_repo_id=params.hf_repo_id,
            voice_gender=params.voice_gender,
        )

    def _dispose() -> None:
        dispose_qwen_tts_model(model, reason="tts_registry_qwen_done")

    info = probe_tts_backend(model_dir, "")
    return TtsSession(
        family=info.family,
        engine=info.engine,
        attention_label=label,
        _model=model,
        _dispose=_dispose,
        _synthesize=_syn,
    )


def _load_piper_session(model_dir: Path, onnx_path: Path) -> TtsSession:
    from piper import PiperVoice

    voice = PiperVoice.load(str(onnx_path))

    def _syn(text: str, out_path: Path, _params: TtsSynthesisParams) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(out_path), "wb") as wf:
            voice.synthesize(text, wf)

    return TtsSession(
        family="piper",
        engine="piper_onnx",
        attention_label="Piper ONNX",
        _model=voice,
        _dispose=lambda: None,
        _synthesize=_syn,
    )


def _load_xtts_session(model_dir: Path, *, use_gpu: bool) -> TtsSession:
    from TTS.api import TTS

    from localgen.torch_device import effective_use_gpu

    gpu = effective_use_gpu(use_gpu)
    device = "cuda" if gpu else "cpu"
    tts = TTS(model_path=str(model_dir), gpu=gpu)

    def _syn(text: str, out_path: Path, params: TtsSynthesisParams) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        lang = (params.language or "en").strip()
        if len(lang) > 2:
            lang = lang[:2].lower()
        kwargs: dict[str, Any] = {"text": text, "file_path": str(out_path), "language": lang}
        sp = (params.speaker or "").strip()
        if sp and not sp.lower().startswith("default"):
            kwargs["speaker"] = sp
        tts.tts_to_file(**kwargs)

    def _dispose() -> None:
        del tts

    return TtsSession(
        family="xtts",
        engine="coqui_xtts",
        attention_label=f"Coqui XTTS ({device})",
        _model=tts,
        _dispose=_dispose,
        _synthesize=_syn,
    )


def load_tts_session(
    model_dir: Path,
    *,
    repo_id: str,
    use_gpu: bool = True,
    use_flash_attention: bool = False,
) -> TtsSession:
    """Load the correct backend for ``model_dir`` / ``repo_id``."""
    info = probe_tts_backend(model_dir, repo_id)
    if not info.backend_supported:
        reason = info.unsupported_reason or f"Unsupported TTS family: {info.family}"
        raise RuntimeError(reason)

    if info.family in ("qwen3_tts_custom_voice", "qwen3_tts_voice_design"):
        return _load_qwen_session(model_dir, use_gpu=use_gpu, use_flash=use_flash_attention)

    if info.family == "piper":
        onnx = _find_piper_onnx(model_dir)
        if onnx is None:
            raise RuntimeError("Piper ONNX model file not found")
        return _load_piper_session(model_dir, onnx)

    if info.family == "xtts":
        return _load_xtts_session(model_dir, use_gpu=use_gpu)

    raise RuntimeError(info.unsupported_reason or f"Unsupported TTS family: {info.family}")
