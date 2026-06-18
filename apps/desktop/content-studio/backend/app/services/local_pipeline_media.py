"""Run local TTS for pipeline jobs after the script outline exists (uses `localgen` + downloaded weights)."""

from __future__ import annotations

import wave
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.config import settings
from app.models import JobLog
from app.services import local_generation
from app.services.generation_defaults import effective_tts_repo_id
from app.services.generation_models_paths import generation_models_root
from app.services.model_folder_discovery import discover_tts_model_dir, resolve_hf_style_load_path
from app.services.tts_language import normalize_tts_language


def _legacy_catalog_tts_dir(repo_id: str) -> Path | None:
    catalog = local_generation.catalog_tts_models()
    entry = next((e for e in catalog.values() if e.get("id") == repo_id), None)
    if entry is None:
        from localgen.registry import DEFAULT_TTS_CATALOG_KEY

        entry = catalog.get(DEFAULT_TTS_CATALOG_KEY) or next(iter(catalog.values()), None)
    if not entry:
        return None
    repo_id = entry["id"]
    safe = repo_id.replace("/", "__")
    return generation_models_root() / "tts" / safe


def _resolve_tts_model_dir(preferred_repo_id: str | None = None) -> tuple[Path | None, str]:
    """
    Prefer a user-pinned HF repo under ``tts/<org__repo>/`` when provided and present.
    When unset, use :data:`DEFAULT_TTS_REPO_ID`, then scan ``tts/*``, then catalog layout.
    """
    root = generation_models_root()
    user_pin = (preferred_repo_id or "").strip() or None
    target_repo = user_pin or effective_tts_repo_id(None)
    origin = f"pinned ({target_repo})" if user_pin else f"default ({target_repo})"

    base = root / "tts" / target_repo.replace("/", "__")
    resolved = resolve_hf_style_load_path(base)
    if resolved is not None:
        return resolved, origin

    discovered = discover_tts_model_dir(root)
    if discovered is not None:
        return discovered, f"discovered ({discovered})"

    legacy_base = _legacy_catalog_tts_dir(target_repo)
    if legacy_base is not None:
        resolved = resolve_hf_style_load_path(legacy_base)
        if resolved is not None:
            return resolved, f"catalog layout ({resolved})"

    return None, ""


def _write_silent_wav(path: Path, duration_seconds: float, sample_rate: int = 24000) -> None:
    """PCM16 mono silence — lets ffmpeg run when TTS weights are missing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = max(1, int(duration_seconds * sample_rate))
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00" * (n * 2))


def _pcm16_wav_peak_abs(path: Path) -> int | None:
    """First ~10s peak absolute sample; None if not a plain PCM16 WAV."""
    import struct

    try:
        with wave.open(str(path), "rb") as wf:
            if wf.getsampwidth() != 2:
                return None
            ch = wf.getnchannels()
            if ch not in (1, 2):
                return None
            nframes = min(wf.getnframes(), 24000 * 10)
            raw = wf.readframes(nframes)
    except Exception:  # noqa: BLE001
        return None
    if len(raw) < 2:
        return 0
    samples = struct.unpack(f"<{len(raw)//2}h", raw[: len(raw) // 2 * 2])
    return max(abs(x) for x in samples)


def _wav_peak_abs(path: Path) -> int | None:
    """Peak sample (PCM16 scale) for PCM16 or float WAV from soundfile."""
    peak = _pcm16_wav_peak_abs(path)
    if peak is not None:
        return peak
    try:
        import numpy as np
        import soundfile as sf

        data, _sr = sf.read(str(path), dtype="float32", always_2d=True)
        if data.size == 0:
            return 0
        mx = float(np.max(np.abs(data)))
        if mx <= 0:
            return 0
        return int(min(32767, mx * 32767)) if mx <= 1.5 else int(min(32767, mx))
    except Exception:  # noqa: BLE001
        return None


from app.services.script_scenes import sorted_script_scenes as _sorted_script_scenes


def _storage_audio_dir(project_id: str, job_id: str) -> Path:
    root = Path(settings.storage_path).expanduser().resolve()
    return root / project_id / job_id / "audio"


def run_local_tts_for_job(
    db: Session,
    *,
    job_id: str,
    project_id: str,
    script_content: dict[str, Any],
    speaker: str = "Ryan",
    language: str = "English",
    instruct: str | None = None,
    hf_tts_repo_id: str | None = None,
    voice_gender: str = "any",
) -> str:
    """
    Synthesize narration WAV per scene with **one model load for the whole job**.

    Reusing a single ``Qwen3TTSModel`` instance across scenes is what keeps the voice tone
    consistent — a fresh ``from_pretrained`` per scene produces audibly different timbre,
    which is what the user reports as "voice in one scene has a different tone than the next".

    Falls back to silent WAVs (per scene duration) when weights are missing, so ffmpeg still runs.

    Returns a one-line summary for the job's final log message.
    """
    scenes = _sorted_script_scenes(script_content)
    if not scenes:
        db.add(JobLog(job_id=job_id, level="info", message="Local TTS: no scenes in script; skipping audio."))
        db.commit()
        return "No scenes to synthesize."

    requested_language = language
    language = normalize_tts_language(language)
    if language != requested_language:
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message=f"Local TTS: normalized language «{requested_language}» → «{language}»",
            )
        )
        db.commit()

    out_dir = _storage_audio_dir(project_id, job_id)
    out_dir.mkdir(parents=True, exist_ok=True)

    user_pin = (hf_tts_repo_id or "").strip() or None
    effective_repo = effective_tts_repo_id(user_pin)
    model_dir, origin_label = _resolve_tts_model_dir(user_pin)
    if user_pin and not origin_label.startswith("pinned"):
        db.add(
            JobLog(
                job_id=job_id,
                level="warning",
                message=(
                    f"Local TTS: pinned repo «{user_pin}» not found under "
                    f"{generation_models_root() / 'tts' / user_pin.replace('/', '__')} — using automatic folder selection."
                ),
            )
        )
        db.commit()
    if model_dir is None:
        db.add(
            JobLog(
                job_id=job_id,
                level="warning",
                message=(
                    "Local TTS: no usable folder under "
                    f"{generation_models_root() / 'tts'} (any name OK). "
                    "Writing silent WAV placeholders so ffmpeg can proceed."
                ),
            )
        )
        db.commit()
        for i, scene in enumerate(scenes):
            if not isinstance(scene, dict):
                continue
            sn = int(scene.get("scene_number") or i + 1)
            dur = float(scene.get("duration_seconds") or 5)
            _write_silent_wav(out_dir / f"scene_{sn:02d}.wav", dur)
        return "TTS: no weights found — silent audio placeholders."

    instr_log = ""
    if instruct:
        instr_log = f" instruct=«{(instruct[:80] + '…') if len(instruct) > 80 else instruct}»"
    db.add(
        JobLog(
            job_id=job_id,
            level="info",
            message=f"Local TTS: weights {origin_label}; speaker={speaker}; voice_gender={voice_gender}; language={language}{instr_log}",
        )
    )
    db.commit()

    # Image VRAM is released in pipeline_render after all scenes; avoid duplicate unload here.

    from localgen.attention_backend import should_prefer_flash_attention
    from localgen.registry import infer_tts_repo_id_from_model_dir
    from localgen.torch_device import effective_use_gpu
    from localgen.tts_registry import TtsSynthesisParams, load_tts_session

    try:
        use_gpu = effective_use_gpu(True)
        use_flash = should_prefer_flash_attention(use_gpu=use_gpu)
        tts_session = load_tts_session(
            model_dir,
            repo_id=effective_repo,
            use_gpu=use_gpu,
            use_flash_attention=use_flash,
        )
        db.add(
            JobLog(
                job_id=job_id,
                level="info",
                message=(
                    f"Local TTS: backend={tts_session.engine} family={tts_session.family}; "
                    f"attention={tts_session.attention_label}"
                ),
            )
        )
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.add(
            JobLog(
                job_id=job_id,
                level="error",
                message=(
                    f"Local TTS: model load failed ({exc}). Writing silent WAV placeholders so "
                    "ffmpeg can still produce a video."
                ),
            )
        )
        db.commit()
        for i, scene in enumerate(scenes):
            if not isinstance(scene, dict):
                continue
            sn = int(scene.get("scene_number") or i + 1)
            dur = float(scene.get("duration_seconds") or 5)
            _write_silent_wav(out_dir / f"scene_{sn:02d}.wav", dur)
        return "TTS load failed — silent audio placeholders."

    effective_repo = effective_repo or infer_tts_repo_id_from_model_dir(model_dir)
    synth_params = TtsSynthesisParams(
        language=language,
        speaker=speaker,
        instruct=instruct,
        voice_gender=voice_gender,
        hf_repo_id=effective_repo,
    )

    ok = 0
    try:
        for i, scene in enumerate(scenes):
            if not isinstance(scene, dict):
                continue
            sn = int(scene.get("scene_number") or i + 1)
            raw = (scene.get("narration_text") or "").strip()
            wav_path = out_dir / f"scene_{sn:02d}.wav"
            dur = float(scene.get("duration_seconds") or 5)
            if not raw:
                _write_silent_wav(wav_path, dur)
                ok += 1
                db.add(
                    JobLog(
                        job_id=job_id,
                        level="info",
                        message=f"Local TTS: scene {sn} silent ({dur:.1f}s — no narration)",
                    )
                )
                db.commit()
                continue
            text = raw
            try:
                db.add(JobLog(job_id=job_id, level="info", message=f"Local TTS: scene {sn} synthesizing ({len(text)} chars)…"))
                db.commit()
                tts_session.synthesize(text, wav_path, synth_params)
                peak = _wav_peak_abs(wav_path)
                if peak is not None and peak <= 8:
                    db.add(
                        JobLog(
                            job_id=job_id,
                            level="warning",
                            message=(
                                f"Local TTS: scene {sn} WAV peak sample={peak} (nearly silent). "
                                "Check speaker/language vs model, GPU/TTS install, or gpu_runtime logs."
                            ),
                        )
                    )
                    db.commit()
                ok += 1
                db.add(JobLog(job_id=job_id, level="info", message=f"Local TTS: scene {sn} wrote {wav_path.name}"))
                db.commit()
            except Exception as exc:  # noqa: BLE001
                db.add(
                    JobLog(
                        job_id=job_id,
                        level="warning",
                        message=f"Local TTS: scene {sn} failed ({exc}); silent placeholder.",
                    )
                )
                db.commit()
                dur = float(scene.get("duration_seconds") or 5)
                _write_silent_wav(wav_path, dur)
    finally:
        tts_session.dispose()

    silent_scenes = 0
    for i, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        sn = int(scene.get("scene_number") or i + 1)
        wav_path = out_dir / f"scene_{sn:02d}.wav"
        peak = _wav_peak_abs(wav_path)
        if peak is not None and peak <= 8:
            silent_scenes += 1

    rel = out_dir
    try:
        rel = out_dir.relative_to(Path.cwd())
    except ValueError:
        pass
    summary = f"Synthesized {ok}/{len(scenes)} scene WAV file(s) → {rel}"
    if silent_scenes:
        db.add(
            JobLog(
                job_id=job_id,
                level="error",
                message=(
                    f"Local TTS: {silent_scenes}/{len(scenes)} scene WAV(s) are nearly silent "
                    "(peak ≤ 8). Final MP4 may have no audible narration — check earlier logs for "
                    "TTS load failures, wrong model type (custom_voice vs voice_design), or a "
                    "one-word narration_tone (use a full voice preset in briefing)."
                ),
            )
        )
        db.commit()
    return summary
