"""Single image / TTS generation for chat (no Content Studio job row required)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.services.generation_defaults import (
    effective_image_repo_id,
    effective_tts_repo_id,
    effective_video_repo_id,
)
from app.services.local_pipeline_video import run_t2v_clip
from app.services.local_pipeline_media import _resolve_tts_model_dir, _wav_peak_abs
from app.services.local_pipeline_sd3 import _engine_label, _resolve_sd3_model_dir_and_info
from app.services.tts_language import normalize_tts_language
from localgen.registry import image_model_runtime_defaults, infer_tts_repo_id_from_model_dir


def run_chat_image(req: dict[str, Any]) -> dict[str, Any]:
    prompt = str(req.get("prompt") or "").strip()
    out_raw = str(req.get("out_path") or "").strip()
    if not prompt:
        raise ValueError("prompt required")
    if not out_raw:
        raise ValueError("out_path required")

    out_path = Path(out_raw)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    hf_repo = effective_image_repo_id((req.get("hf_image_repo_id") or "").strip() or None)
    width = max(64, int(req.get("width") or 1024))
    height = max(64, int(req.get("height") or 1024))

    model_dir, model_info, origin_label = _resolve_sd3_model_dir_and_info(hf_repo)
    if model_dir is None:
        raise RuntimeError(
            f"Image model «{hf_repo}» is not installed. Download it from Models → Model roles."
        )

    defaults = image_model_runtime_defaults(model_info)
    num_steps = max(1, int(defaults["num_steps"]))
    guidance_scale = float(defaults["guidance_scale"])
    supports_neg = bool(defaults["supports_negative_prompt"])
    engine_label = _engine_label(model_info)

    from localgen.attention_backend import should_prefer_flash_attention
    from localgen.engines import generate_image_file, load_image_pipeline
    from localgen.torch_device import effective_use_gpu, log_image_acceleration

    log_image_acceleration()
    use_gpu = effective_use_gpu(True)
    pipe, attn_label = load_image_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)
    try:
        generate_image_file(
            pipe,
            prompt=prompt,
            negative_prompt=None,
            width=width,
            height=height,
            num_steps=num_steps,
            guidance_scale=guidance_scale,
            seed=int(req.get("seed") or 42),
            out_path=out_path,
            supports_negative_prompt=supports_neg,
        )
    finally:
        try:
            from localgen.gpu_runtime import dispose_sd3_pipeline

            dispose_sd3_pipeline(pipe, reason="chat_image_done")
        except Exception:  # noqa: BLE001
            pass

    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise RuntimeError(f"{engine_label} produced no image file")

    return {
        "summary": f"Chat image ({engine_label}, {origin_label}, {width}x{height}, attention={attn_label})",
        "out_path": str(out_path),
        "repo_id": hf_repo,
    }


def run_chat_tts(req: dict[str, Any]) -> dict[str, Any]:
    text = str(req.get("text") or "").strip()
    out_raw = str(req.get("out_path") or "").strip()
    if not text:
        raise ValueError("text required")
    if not out_raw:
        raise ValueError("out_path required")

    out_path = Path(out_raw)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    hf_repo = effective_tts_repo_id((req.get("hf_tts_repo_id") or "").strip() or None)
    from app.services.generation_run_kwargs import build_tts_run_kwargs

    tts_kw = build_tts_run_kwargs(
        hf_repo,
        speaker=str(req.get("tts_speaker") or "Ryan").strip() or "Ryan",
        language=str(req.get("tts_language") or "English"),
        instruct=(req.get("tts_instruct") or "").strip() or None,
        voice_gender=str(req.get("tts_voice_gender") or "any"),
        brief_json=req.get("brief_json") if isinstance(req.get("brief_json"), dict) else None,
    )
    speaker = tts_kw["speaker"]
    language = normalize_tts_language(tts_kw["language"])
    instruct = tts_kw["instruct"]
    voice_gender = tts_kw["voice_gender"]

    model_dir, origin_label = _resolve_tts_model_dir(hf_repo)
    if model_dir is None:
        raise RuntimeError(
            f"TTS model «{hf_repo}» is not installed. Download it from Models → Model roles."
        )

    from localgen.attention_backend import should_prefer_flash_attention
    from localgen.registry import infer_tts_repo_id_from_model_dir
    from localgen.torch_device import effective_use_gpu, log_image_acceleration
    from localgen.tts_registry import TtsSynthesisParams, load_tts_session

    log_image_acceleration()
    use_gpu = effective_use_gpu(True)
    use_flash = should_prefer_flash_attention(use_gpu=use_gpu)
    tts_session = load_tts_session(
        model_dir,
        repo_id=hf_repo,
        use_gpu=use_gpu,
        use_flash_attention=use_flash,
    )
    effective_repo = hf_repo or infer_tts_repo_id_from_model_dir(model_dir)
    synth = TtsSynthesisParams(
        language=language,
        speaker=speaker,
        instruct=instruct,
        voice_gender=voice_gender,
        hf_repo_id=effective_repo,
        generation_mode=tts_kw.get("generation_mode"),
    )
    try:
        tts_session.synthesize(text, out_path, synth)
    finally:
        try:
            tts_session.dispose()
        except Exception:  # noqa: BLE001
            pass

    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise RuntimeError("TTS produced no audio file")

    peak = _wav_peak_abs(out_path)
    if peak is not None and peak <= 8:
        raise RuntimeError("TTS audio is nearly silent — check speaker, language, and model install")

    return {
        "summary": (
            f"Chat TTS ({origin_label}, {tts_session.family}, speaker={speaker}, "
            f"attention={tts_session.attention_label})"
        ),
        "out_path": str(out_path),
        "repo_id": effective_repo,
    }


def run_chat_video(req: dict[str, Any]) -> dict[str, Any]:
    prompt = str(req.get("prompt") or "").strip()
    out_raw = str(req.get("out_path") or "").strip()
    if not prompt:
        raise ValueError("prompt required")
    if not out_raw:
        raise ValueError("out_path required")

    out_path = Path(out_raw)
    hf_repo = effective_video_repo_id((req.get("hf_video_repo_id") or "").strip() or None)
    neg = (req.get("negative_prompt") or "").strip() or None
    max_dur_raw = req.get("max_duration_seconds")
    target_duration: float | None = None
    if max_dur_raw is not None:
        try:
            parsed = float(max_dur_raw)
            if parsed > 0:
                target_duration = parsed
        except (TypeError, ValueError):
            pass

    summary = run_t2v_clip(
        prompt=prompt,
        out_path=out_path,
        hf_video_repo_id=hf_repo,
        negative_prompt=neg,
        num_frames=int(req["num_frames"]) if req.get("num_frames") is not None else None,
        num_steps=int(req["num_steps"]) if req.get("num_steps") is not None else None,
        guidance_scale=float(req["guidance_scale"]) if req.get("guidance_scale") is not None else None,
        fps=int(req["fps"]) if req.get("fps") is not None else None,
        seed=int(req.get("seed") or 42),
        prefer_full_gpu=bool(req.get("prefer_full_gpu")),
        target_duration_seconds=target_duration,
    )

    return {
        "summary": f"Chat video — {summary}",
        "out_path": str(out_path),
        "repo_id": hf_repo,
    }
