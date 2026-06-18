"""Headless TTS / image generation (optional heavy deps: torch, qwen-tts, diffusers)."""

from __future__ import annotations

import os
import warnings
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf

# Diffusers' SDXL pipeline still triggers an internal `upcast_vae` deprecation warning
# (see huggingface/diffusers PR 12619). It fires once per pipeline call, so a 5-scene job
# spams the log 5× with no actionable info. Silence it at our boundary.
warnings.filterwarnings(
    "ignore",
    message=r".*upcast_vae.*",
    category=FutureWarning,
    module=r"diffusers\.pipelines\.stable_diffusion_xl\..*",
)


from localgen.attention_backend import (
    configure_diffusers_pipeline_attention,
    configure_pytorch_sdp_backends,
    flash_attention_available,
    load_with_hf_attention,
    log_attention_choice,
    should_prefer_flash_attention,
    should_use_flash_attention_for_images,
    static_attention_label,
)


def _extras_install_hint(*, profile: str) -> str:
    """Missing pip packages in the worker interpreter — unrelated to HF weights under ~/.omega."""
    import sys

    from localgen.paths import get_models_root

    py = sys.executable
    weights_root = get_models_root()
    return (
        f"Missing ML Python packages in {py} (profile [{profile}] needs torch/diffusers; "
        f"video also needs imageio + imageio-ffmpeg). "
        f"Downloaded weights under {weights_root} are separate — run Omega welcome setup or "
        "Content Studio → environment setup (installs torch + generation_models[tts,image])."
    )


def load_qwen_tts_model(
    model_dir: Path,
    *,
    use_gpu: bool,
    use_flash_attention: bool,
) -> tuple[Any, str]:
    """
    Load the Qwen3 TTS weights once.

    Returns ``(model, attention_label)`` where ``attention_label`` is a short string for
    job logs (e.g. ``FlashAttention 2``, ``PyTorch SDPA (CPU)``).

    Pair with :func:`generate_qwen_speech` for per-scene inference and
    :func:`localgen.gpu_runtime.dispose_qwen_tts_model` at end of job. Re-using one model
    instance across all scenes is what gives consistent voice tone — a fresh
    ``from_pretrained`` per scene produces audibly different timbre even with the same
    speaker name because the custom-voice embedding gets re-initialized each load.
    """
    from localgen.gpu_runtime import after_use, before_load

    try:
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="tts")) from e

    before_load("tts", reason="load_qwen_tts_model")
    try:
        from localgen.torch_device import (
            effective_use_gpu,
            inference_dtype,
            move_module_to_device,
            tts_load_device_map,
        )

        gpu_ok = effective_use_gpu(use_gpu)
        device_map = tts_load_device_map(want_gpu=use_gpu)
        dtype = inference_dtype(want_gpu=use_gpu)
        prefer = use_flash_attention and should_prefer_flash_attention(use_gpu=use_gpu)
        model, label = load_with_hf_attention(
            Qwen3TTSModel.from_pretrained,
            str(model_dir),
            use_gpu=use_gpu,
            prefer_flash=prefer,
            component="TTS",
            device_map=device_map,
            dtype=dtype,
        )
        if gpu_ok and device_map == "cpu":
            model, _acc, dev_label = move_module_to_device(model, want_gpu=True)
            label = f"{label} ({dev_label})"
        return model, label
    except Exception:
        after_use(reason="load_qwen_tts_model_failed")
        raise


def _voice_design_timbre_prefix(speaker: str, voice_gender: str | None) -> str:
    """
    VoiceDesign checkpoints only consume ``instruct`` (no named ``speaker`` id).

    The desktop UI still picks a preset character (Ryan, Aiden, …) and a gender filter; we
    fold those into natural-language steering so timbre tracks the user's choices.
    """
    from localgen.registry import SPEAKERS

    sp = (speaker or "").strip() or "Ryan"
    vg = (voice_gender or "any").strip().lower()
    meta = SPEAKERS.get(sp) or {}
    reg_gender = (meta.get("gender") or "").strip()
    desc = (meta.get("description") or "").strip()
    lang_note = (meta.get("language") or "").strip()

    chunks: list[str] = []
    if vg == "male":
        chunks.append("The speaking voice must be clearly male-presenting.")
    elif vg == "female":
        chunks.append("The speaking voice must be clearly female-presenting.")

    if meta:
        who = f"Channel the preset character «{sp}» ({reg_gender}" + (f", {lang_note}" if lang_note else "") + ")."
        chunks.append(who)
        if desc:
            chunks.append(desc)
    else:
        chunks.append(
            f"Use one consistent fictional timbre associated with the label «{sp}»; "
            "keep the same apparent gender and age across the whole take."
        )

    chunks.append("Do not drift into a different gender, age band, or accent between sentences.")
    return " ".join(chunks) + " "


def generate_qwen_speech(
    model: Any,
    text: str,
    out_path: Path,
    *,
    language: str,
    speaker: str,
    instruct: str | None,
    hf_repo_id: str | None = None,
    voice_gender: str | None = None,
) -> tuple[Any, int]:
    """
    Run inference on an already-loaded Qwen3 TTS model and write a WAV.

    ``model`` is the handle returned by :func:`load_qwen_tts_model`; do NOT call
    ``from_pretrained`` here — that would defeat the cross-scene consistency this split
    exists to provide.

    ``hf_repo_id`` selects the generation API via :func:`localgen.registry.tts_generation_mode_for_repo`:
    ``custom_voice`` checkpoints call ``generate_custom_voice`` (named ``speaker`` + ``instruct``);
    ``voice_design`` checkpoints call ``generate_voice_design`` (``text`` + ``instruct`` + ``language``),
    matching the official VoiceDesign layout and community bundles like ``aiseosae/qwenTTS``.
    For ``voice_design``, ``speaker`` / ``voice_gender`` are folded into ``instruct`` because
    that API has no separate speaker id.
    """
    from localgen.registry import tts_generation_mode_for_repo

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    mode = tts_generation_mode_for_repo(hf_repo_id)

    if mode == "voice_design":
        lang = (language or "English").strip()
        if not lang:
            lang = "English"
        # Model card examples use lowercase language codes (e.g. ``language="english"``).
        lang_arg = lang[:1].lower() + lang[1:] if len(lang) > 1 else lang.lower()
        prefix = _voice_design_timbre_prefix(speaker, voice_gender)
        user = (instruct or "").strip()
        if user:
            instruct_final = prefix + user
        else:
            instruct_final = prefix + (
                "Clear, neutral narration with natural pacing and a mid-range pitch."
            )
        wavs, sr = model.generate_voice_design(
            text=text,
            instruct=instruct_final,
            language=lang_arg,
        )
        sf.write(str(out_path), wavs[0], sr, subtype="PCM_16")
        return wavs, int(sr)

    wavs, sr = model.generate_custom_voice(
        text=text,
        language=language,
        speaker=speaker,
        instruct=instruct if instruct else None,
    )
    sf.write(str(out_path), wavs[0], sr, subtype="PCM_16")
    return wavs, int(sr)


def synthesize_qwen_wav(
    model_dir: Path,
    text: str,
    out_path: Path,
    *,
    language: str,
    speaker: str,
    instruct: str | None,
    use_gpu: bool,
    use_flash_attention: bool,
    hf_repo_id: str | None = None,
    voice_gender: str | None = None,
) -> tuple[Any, int]:
    """One-shot convenience: load → generate one wav → dispose. Prefer the split API for jobs."""
    from localgen.gpu_runtime import dispose_qwen_tts_model

    model, _ = load_qwen_tts_model(model_dir, use_gpu=use_gpu, use_flash_attention=use_flash_attention)
    try:
        return generate_qwen_speech(
            model,
            text,
            out_path,
            language=language,
            speaker=speaker,
            instruct=instruct,
            hf_repo_id=hf_repo_id,
            voice_gender=voice_gender,
        )
    finally:
        dispose_qwen_tts_model(model, reason="synthesize_qwen_wav_done")


def _pipe_compute_dtype(pipe: Any) -> Any:
    """UNet/transformer dtype — pipelines do not expose ``pipe.dtype``."""
    try:
        import torch
    except ImportError:
        return None
    for attr in ("unet", "transformer", "transformer_2"):
        mod = getattr(pipe, attr, None)
        if mod is None:
            continue
        try:
            return next(mod.parameters()).dtype
        except StopIteration:
            continue
    return torch.float16


def _apply_sdxl_inference_tweaks(pipe: Any, dtype: Any | None = None) -> None:
    """
    SDXL helpers: VAE slicing/tiling for VRAM; UNet in fp16 on GPU.

    Do **not** set ``vae.config.force_upcast = False`` — fp16 VAE decode without upcast
    often yields solid black frames (diffusers upcasts VAE math to fp32 during decode).
    """
    try:
        import torch
    except ImportError:
        return
    resolved = dtype or _pipe_compute_dtype(pipe)
    if resolved not in (torch.float16, torch.bfloat16):
        return
    try:
        vae = getattr(pipe, "vae", None)
        if vae is not None:
            if hasattr(vae, "enable_slicing"):
                vae.enable_slicing()
            elif hasattr(pipe, "enable_vae_slicing"):
                pipe.enable_vae_slicing()
            if hasattr(vae, "enable_tiling"):
                vae.enable_tiling()
            elif hasattr(pipe, "enable_vae_tiling"):
                pipe.enable_vae_tiling()
        for attr in ("unet", "transformer", "transformer_2", "text_encoder", "text_encoder_2"):
            mod = getattr(pipe, attr, None)
            if mod is None:
                continue
            try:
                mod.to(dtype=resolved)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _warn_if_decoded_image_too_dark(image: Any, out_path: Path) -> None:
    """Log when VAE output is nearly black (common fp16 VAE misconfiguration)."""
    import sys

    try:
        from PIL import ImageStat

        if not hasattr(image, "convert"):
            return
        stat = ImageStat.Stat(image.convert("RGB"))
        mean = sum(stat.mean) / max(1, len(stat.mean))
        if mean >= 12.0:
            return
        print(
            f"localgen.diffusion: WARNING {out_path.name} mean luminance={mean:.1f} "
            f"(nearly black — check VAE upcast / fp16 decode)",
            file=sys.stderr,
            flush=True,
        )
    except Exception:  # noqa: BLE001
        pass


def _log_diffusion_compute_profile(pipe: Any, *, steps: int, width: int, height: int) -> None:
    """One stderr line for speed regressions (compare with standalone qwen_tts_gui)."""
    import sys

    try:
        import torch
    except ImportError:
        return
    bits: list[str] = [f"steps={steps}", f"size={width}x{height}"]
    for attr in ("unet", "vae"):
        mod = getattr(pipe, attr, None)
        if mod is None:
            continue
        try:
            p = next(mod.parameters())
            bits.append(f"{attr}={p.device}:{p.dtype}")
        except StopIteration:
            pass
    bits.append(f"torch={getattr(torch, '__version__', '?')}")
    print(f"localgen.diffusion: compute profile - {'; '.join(bits)}", file=sys.stderr, flush=True)


def _offload_sdxl_text_encoders(pipe: Any) -> None:
    """Move CLIP stacks off GPU after encode — frees ~2–4 GiB for UNet at 1024²."""
    import sys

    import torch

    moved = 0
    for attr in ("text_encoder", "text_encoder_2"):
        mod = getattr(pipe, attr, None)
        if mod is None:
            continue
        try:
            mod.to("cpu")
            moved += 1
        except Exception:  # noqa: BLE001
            pass
    if moved and torch.cuda.is_available():
        torch.cuda.empty_cache()
        free_b, total_b = torch.cuda.mem_get_info(0)
        print(
            f"localgen.diffusion: offloaded {moved} text encoder(s) to CPU; "
            f"vram_free_mib={free_b // (1024 * 1024)}/{total_b // (1024 * 1024)}",
            file=sys.stderr,
            flush=True,
        )


def _disable_diffusers_tqdm() -> bool:
    in_worker = os.environ.get("OMEGA_CS_WORKER", "").strip() == "1"
    return in_worker or os.environ.get("OMEGA_CS_DISABLE_TQDM", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _image_inference_standalone_parity() -> bool:
    """Match ``qwen_tts_gui`` ImageGenWorker (default on; set OMEGA_CS_IMAGE_STANDALONE_PARITY=0 to opt out)."""
    return os.environ.get("OMEGA_CS_IMAGE_STANDALONE_PARITY", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _cuda_free_mib(device_index: int = 0) -> int | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free_b, _total_b = torch.cuda.mem_get_info(device_index)
        return int(free_b // (1024 * 1024))
    except Exception:  # noqa: BLE001
        return None


def _cuda_total_mib(device_index: int = 0) -> int | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        _free_b, total_b = torch.cuda.mem_get_info(device_index)
        return int(total_b // (1024 * 1024))
    except Exception:  # noqa: BLE001
        return None


def _sdxl_text_encoder_offload_enabled() -> bool:
    """
    Whether to pre-encode SDXL prompts and move text encoders to CPU.

    Default is **all GPU** (``OMEGA_CS_IMAGE_VRAM_MODE=all_gpu``). Users can pick
    ``offload_encoders`` in Settings or ``auto`` on small GPUs (<10 GiB total VRAM).

    ``auto`` must **not** use free VRAM after the pipeline is loaded: a 16 GiB card
    often shows only ~2–4 GiB free while the model is resident — that is normal, not
  low VRAM. Using free MiB there forced CPU text-encoder offload and ~10× slower steps
    vs standalone ``qwen_tts_gui``.
    """
    mode = os.environ.get("OMEGA_CS_IMAGE_VRAM_MODE", "all_gpu").strip().lower()
    if mode in ("all_gpu", "gpu", "full_gpu", "none", ""):
        return False
    if mode in ("offload_encoders", "offload", "cpu_encoders"):
        return True
    if mode == "auto":
        total_mib = _cuda_total_mib()
        if total_mib is None:
            return False
        return total_mib < 10_240
    legacy = os.environ.get("OMEGA_CS_OFFLOAD_TEXT_ENCODERS", "0").strip().lower()
    return legacy in ("1", "true", "yes", "on")


def _prepare_sdxl_embeds_call_kwargs(pipe: Any, call_kwargs: dict[str, Any]) -> dict[str, Any]:
    """
    Pre-encode prompts and offload text encoders (SDXL only).

    Standalone ``qwen_tts_gui`` passes ``prompt=`` directly (all on GPU). Only used when
    Settings → Omega tools → image VRAM mode is ``offload_encoders`` or ``auto`` with low VRAM.
    """
    if not _sdxl_text_encoder_offload_enabled():
        return call_kwargs
    if "prompt" not in call_kwargs:
        return call_kwargs
    if getattr(pipe, "unet", None) is None:
        return call_kwargs
    encode = getattr(pipe, "encode_prompt", None)
    if not callable(encode):
        return call_kwargs

    import torch

    prompt = call_kwargs.pop("prompt")
    negative_prompt = call_kwargs.pop("negative_prompt", None)
    guidance_scale = float(call_kwargs.get("guidance_scale", 7.5))
    do_cfg = guidance_scale > 1.0
    device = getattr(pipe, "_execution_device", None) or getattr(pipe, "device", None)
    if device is None:
        from localgen.torch_device import effective_use_gpu, resolve_torch_device

        device = resolve_torch_device(want_gpu=effective_use_gpu(True))

    try:
        encoded = encode(
            prompt=prompt,
            prompt_2=prompt,
            device=device,
            num_images_per_prompt=1,
            do_classifier_free_guidance=do_cfg,
            negative_prompt=negative_prompt,
            negative_prompt_2=negative_prompt,
        )
    except TypeError:
        call_kwargs["prompt"] = prompt
        if negative_prompt is not None:
            call_kwargs["negative_prompt"] = negative_prompt
        return call_kwargs

    if isinstance(encoded, tuple) and len(encoded) == 4:
        (
            call_kwargs["prompt_embeds"],
            call_kwargs["negative_prompt_embeds"],
            call_kwargs["pooled_prompt_embeds"],
            call_kwargs["negative_pooled_prompt_embeds"],
        ) = encoded
        _offload_sdxl_text_encoders(pipe)
    else:
        call_kwargs["prompt"] = prompt
        if negative_prompt is not None:
            call_kwargs["negative_prompt"] = negative_prompt
    return call_kwargs


_SDXL_EMBED_KEYS = (
    "prompt_embeds",
    "negative_prompt_embeds",
    "pooled_prompt_embeds",
    "negative_pooled_prompt_embeds",
)


def _unet_device_for_pipe(pipe: Any, *, want_gpu: bool = True) -> Any:
    import torch

    from localgen.torch_device import effective_use_gpu, resolve_torch_device

    unet = getattr(pipe, "unet", None)
    if unet is not None:
        try:
            return unet.device
        except Exception:  # noqa: BLE001
            pass
    dev = getattr(pipe, "_execution_device", None) or getattr(pipe, "device", None)
    if dev is not None:
        return dev
    return resolve_torch_device(want_gpu=want_gpu and effective_use_gpu(want_gpu))


def _move_sdxl_embed_tensors_to_unet_device(pipe: Any, call_kwargs: dict[str, Any]) -> dict[str, Any]:
    """Pre-encoded SDXL embeds must sit on the UNet device after text encoders move to CPU."""
    if "prompt_embeds" not in call_kwargs:
        return call_kwargs
    import torch

    device = _unet_device_for_pipe(pipe)
    for key in _SDXL_EMBED_KEYS:
        tensor = call_kwargs.get(key)
        if isinstance(tensor, torch.Tensor):
            call_kwargs[key] = tensor.to(device)
    return call_kwargs


def _torch_generator_for_inference(pipe: Any, seed: int, call_kwargs: dict[str, Any]) -> Any | None:
    """Match ``qwen_tts_gui``: ``torch.Generator(device=pipe.device)`` for plain-prompt runs."""
    import torch

    if seed == -1:
        return None
    if "prompt_embeds" in call_kwargs:
        device = _unet_device_for_pipe(pipe)
    else:
        device = getattr(pipe, "device", None) or _unet_device_for_pipe(pipe)
    gen = torch.Generator(device=device)
    gen.manual_seed(int(seed))
    return gen


def _generate_image_file_standalone_parity(
    pipe: Any,
    *,
    prompt: str,
    negative_prompt: str | None,
    width: int,
    height: int,
    num_steps: int,
    guidance_scale: float,
    seed: int,
    out_path: Path,
    supports_negative_prompt: bool,
    cancel_check: Callable[[], None] | None,
) -> None:
    """Same inference path as ``qwen_tts_gui.ImageGenWorker.run``."""
    import sys
    import time

    import torch

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    steps = max(1, int(num_steps))

    if hasattr(pipe, "set_progress_bar_config"):
        try:
            pipe.set_progress_bar_config(disable=_disable_diffusers_tqdm(), leave=False)
        except Exception:  # noqa: BLE001
            pass

    generator = None
    if seed != -1:
        from localgen.torch_device import resolve_generator_device

        gen_device = resolve_generator_device(pipe, want_gpu=True)
        generator = torch.Generator(device=gen_device).manual_seed(int(seed))

    if cancel_check is not None:
        cancel_check()

    call_kwargs: dict[str, Any] = {
        "prompt": prompt,
        "num_inference_steps": steps,
        "guidance_scale": float(guidance_scale),
        "height": int(height),
        "width": int(width),
        "generator": generator,
    }
    if supports_negative_prompt:
        call_kwargs["negative_prompt"] = negative_prompt if negative_prompt else None

    device = getattr(pipe, "device", None)
    print(
        f"localgen.diffusion: qwen_tts_gui parity — {steps} steps at {width}x{height} (device={device})",
        file=sys.stderr,
        flush=True,
    )
    t0 = time.perf_counter()
    with torch.inference_mode():
        result = pipe(**call_kwargs)
    denoise_s = time.perf_counter() - t0
    per_step = denoise_s / steps if steps else denoise_s
    print(
        f"localgen.diffusion: denoise finished in {denoise_s:.1f}s "
        f"({per_step:.2f}s/step avg; >3s/step → check Image VRAM mode is All GPU, not Auto)",
        file=sys.stderr,
        flush=True,
    )
    if cancel_check is not None:
        cancel_check()
    image = result.images[0]
    _warn_if_decoded_image_too_dark(image, out_path)
    image.save(str(out_path))
    print(f"localgen.diffusion: saved {out_path.name}", file=sys.stderr, flush=True)


def generate_image_file(
    pipe: Any,
    *,
    prompt: str,
    negative_prompt: str | None,
    width: int,
    height: int,
    num_steps: int,
    guidance_scale: float,
    seed: int,
    out_path: Path,
    supports_negative_prompt: bool = True,
    cancel_check: Callable[[], None] | None = None,
) -> None:
    """
    Run inference on any diffusers-style pipeline and write a PNG.

    Set ``supports_negative_prompt=False`` for engines that don't accept the kwarg
    (e.g. ``ZImagePipeline``); the call will omit it instead of passing ``None``.
    """
    import sys

    import torch

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    steps = max(1, int(num_steps))

    if _image_inference_standalone_parity():
        _generate_image_file_standalone_parity(
            pipe,
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_steps=steps,
            guidance_scale=guidance_scale,
            seed=seed,
            out_path=out_path,
            supports_negative_prompt=supports_negative_prompt,
            cancel_check=cancel_check,
        )
        return

    device = getattr(pipe, "device", None)
    compute_dtype = _pipe_compute_dtype(pipe)
    _log_diffusion_compute_profile(pipe, steps=steps, width=width, height=height)
    if hasattr(pipe, "set_progress_bar_config"):
        try:
            pipe.set_progress_bar_config(disable=_disable_diffusers_tqdm(), leave=False)
        except Exception:  # noqa: BLE001
            pass
    call_kwargs: dict[str, Any] = {
        "prompt": prompt,
        "num_inference_steps": steps,
        "guidance_scale": float(guidance_scale),
        "height": int(height),
        "width": int(width),
    }
    if supports_negative_prompt:
        call_kwargs["negative_prompt"] = negative_prompt if negative_prompt else None

    call_kwargs = _prepare_sdxl_embeds_call_kwargs(pipe, call_kwargs)
    call_kwargs = _move_sdxl_embed_tensors_to_unet_device(pipe, call_kwargs)
    generator = _torch_generator_for_inference(pipe, seed, call_kwargs)
    if generator is not None:
        call_kwargs["generator"] = generator

    if cancel_check is not None:
        cancel_check()

    # Standalone qwen_tts_gui calls pipe() with no step callback. diffusers'
    # callback_on_step_end forces GPU↔CPU sync every step and can be 10–100× slower.
    use_step_callback = os.environ.get("OMEGA_CS_STEP_CANCEL_CALLBACK", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if use_step_callback and cancel_check is not None:
        try:
            check_every = max(1, int(os.environ.get("OMEGA_CS_CANCEL_CHECK_EVERY_STEPS", "4")))
        except Exception:  # noqa: BLE001
            check_every = 4

        def _on_step_end(
            _pipe: Any, step: int, _timestep: int, callback_kwargs: dict[str, Any]
        ) -> dict[str, Any]:
            if (step + 1) % check_every == 0:
                cancel_check()
            return callback_kwargs

        call_kwargs["callback_on_step_end"] = _on_step_end
        call_kwargs["callback_on_step_end_tensor_inputs"] = []

    print(
        f"localgen.diffusion: encoding prompt + running {steps} steps at {width}x{height} "
        f"(device={device}; step_callback={'on' if use_step_callback else 'off'})",
        file=sys.stderr,
        flush=True,
    )
    import threading
    import time

    t0 = time.perf_counter()
    heartbeat_stop = threading.Event()

    def _denoise_heartbeat() -> None:
        while not heartbeat_stop.wait(20.0):
            elapsed = int(time.perf_counter() - t0)
            print(
                f"localgen.diffusion: still running ({elapsed}s elapsed)",
                file=sys.stderr,
                flush=True,
            )

    heartbeat = threading.Thread(target=_denoise_heartbeat, name="localgen_denoise_hb", daemon=True)
    heartbeat.start()
    try:
        # Match qwen_tts_gui ImageGenWorker: plain pipe(), no autocast/channels_last.
        with torch.inference_mode():
            result = pipe(**call_kwargs)
    finally:
        heartbeat_stop.set()
    denoise_s = time.perf_counter() - t0
    per_step = denoise_s / steps if steps else denoise_s
    print(
        f"localgen.diffusion: denoise finished in {denoise_s:.1f}s "
        f"({per_step:.2f}s/step avg; >3s/step usually means slow attention or fp32 UNet)",
        file=sys.stderr,
        flush=True,
    )
    if cancel_check is not None:
        cancel_check()
    print("localgen.diffusion: decoding VAE", file=sys.stderr, flush=True)
    image = result.images[0]
    _warn_if_decoded_image_too_dark(image, out_path)
    image.save(str(out_path))
    print(f"localgen.diffusion: saved {out_path.name}", file=sys.stderr, flush=True)


def _image_pipeline_on_cuda(
    pipe: Any,
    label: str,
    *,
    model_dir: Path | None,
    torch_dtype: Any,
    use_gpu: bool,
    component: str,
) -> tuple[Any, str]:
    """Move pipeline to CUDA, DirectML, or leave on CPU; configure attention when on GPU."""
    import torch

    from localgen.attention_backend import (
        _pipeline_uses_fast_attention,
        configure_diffusers_pipeline_attention,
        gpu_attention_mode,
    )
    from localgen.torch_device import diffusers_accelerator, move_module_to_device

    acc = diffusers_accelerator(want_gpu=use_gpu)
    if acc == "cpu":
        return pipe, f"{label} (CPU)"

    pipe, _acc, dev_label = move_module_to_device(pipe, want_gpu=use_gpu)
    if gpu_attention_mode() == "auto" and _pipeline_uses_fast_attention(pipe):
        return pipe, f"{label} ({dev_label})"
    pipe, attn_label = configure_diffusers_pipeline_attention(
        pipe,
        model_dir=model_dir,
        torch_dtype=torch_dtype,
        use_gpu=use_gpu,
        component=component,
    )
    return pipe, f"{attn_label} ({dev_label})"


def _image_load_dtype(model_info: dict[str, Any], use_gpu: bool) -> Any:
    """Dtype for diffusers image load — CPU uses float32; GPU uses catalog / env default."""
    import torch

    from localgen.attention_backend import gpu_attention_mode
    from localgen.torch_device import effective_use_gpu

    dtype_name = str(model_info.get("default_dtype") or "bfloat16")
    engine = str(model_info.get("engine") or "").strip().lower()
    gpu_ok = effective_use_gpu(use_gpu)
    if gpu_ok and gpu_attention_mode() == "auto" and engine.startswith("diffusers"):
        dtype_name = os.environ.get("OMEGA_CS_IMAGE_DTYPE", "float16").strip() or "float16"
    if not gpu_ok:
        return torch.float32
    return _resolve_torch_dtype(dtype_name)


def _resolve_torch_dtype(name: str) -> Any:
    """Map a string ('float16' / 'bfloat16' / 'float32') to the matching ``torch.dtype``."""
    import torch

    n = (name or "").strip().lower()
    if n in ("bf16", "bfloat16"):
        return torch.bfloat16
    if n in ("fp32", "float32"):
        return torch.float32
    return torch.float16


def load_sd3_pipeline(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
    """Load SD3 weights. Call :func:`localgen.gpu_runtime.dispose_sd3_pipeline` when finished so TTS can reuse VRAM."""
    from localgen.gpu_runtime import after_use, before_load

    from localgen.hf_auth import hf_token_argument

    try:
        import torch
        from diffusers import StableDiffusion3Pipeline
        from huggingface_hub import hf_hub_download
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="image")) from e

    _tok = hf_token_argument()

    before_load("sd3", reason="load_sd3_pipeline")
    try:
        dtype = _image_load_dtype(model_info, use_gpu)
        if model_info.get("type") == "lora":
            pipe, label = load_with_hf_attention(
                StableDiffusion3Pipeline.from_pretrained,
                "stabilityai/stable-diffusion-3.5-medium",
                use_gpu=use_gpu,
                component="image-sd3",
                torch_dtype=dtype,
            )
            lora_path = os.path.join(str(model_dir), model_info["lora_file"])
            if not os.path.exists(lora_path):
                lora_path = hf_hub_download(
                    model_info["lora_id"],
                    model_info["lora_file"],
                    local_dir=str(model_dir),
                    token=_tok,
                )
            pipe.load_lora_weights(lora_path)
            pipe.fuse_lora()
        else:
            pipe, label = load_with_hf_attention(
                StableDiffusion3Pipeline.from_pretrained,
                str(model_dir),
                use_gpu=use_gpu,
                component="image-sd3",
                torch_dtype=dtype,
            )
        return _image_pipeline_on_cuda(
            pipe,
            label,
            model_dir=model_dir,
            torch_dtype=dtype,
            use_gpu=use_gpu,
            component="image-sd3",
        )
    except Exception:
        after_use(reason="load_sd3_pipeline_failed")
        raise


def load_zimage_pipeline(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
    """Load Tongyi-MAI/Z-Image-Turbo via ``ZImagePipeline``. Requires diffusers ≥ recent main."""
    from localgen.gpu_runtime import after_use, before_load

    try:
        import torch
        from diffusers import ZImagePipeline
    except ImportError as e:
        raise RuntimeError(
            _extras_install_hint(profile="image")
            + " (ZImagePipeline lives in recent `diffusers`; install from git if missing.)"
        ) from e

    before_load("sd3", reason="load_zimage_pipeline")
    try:
        dtype = _image_load_dtype(model_info, use_gpu)
        low_mem = bool(model_info.get("low_cpu_mem_usage", False))
        pipe, label = load_with_hf_attention(
            ZImagePipeline.from_pretrained,
            str(model_dir),
            use_gpu=use_gpu,
            component="image-zimage",
            torch_dtype=dtype,
            low_cpu_mem_usage=low_mem,
        )
        return _image_pipeline_on_cuda(
            pipe,
            label,
            model_dir=model_dir,
            torch_dtype=dtype,
            use_gpu=use_gpu,
            component="image-zimage",
        )
    except Exception:
        after_use(reason="load_zimage_pipeline_failed")
        raise


def _sdxl_model_index_class(model_dir: Path) -> str | None:
    idx = model_dir / "model_index.json"
    if not idx.is_file():
        return None
    try:
        import json

        data = json.loads(idx.read_text(encoding="utf-8"))
        return str(data.get("_class_name") or "").strip() or None
    except Exception:  # noqa: BLE001
        return None


def load_sdxl_pipeline_standalone_parity(
    model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool
) -> tuple[Any, str]:
    """
    Match ``qwen_tts_gui.load_image_model`` for SDXL folders: ``from_pretrained`` + ``.to('cuda')``.

    No attention patching, no VAE dtype hacks, no text-encoder CPU offload.
    """
    from localgen.gpu_runtime import after_use, before_load

    try:
        import torch
        from diffusers import StableDiffusionXLPipeline
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="image")) from e

    before_load("sd3", reason="load_sdxl_standalone_parity")
    try:
        from localgen.torch_device import effective_use_gpu, inference_dtype, move_module_to_device

        gpu_ok = effective_use_gpu(use_gpu)
        dtype = inference_dtype(want_gpu=use_gpu) if gpu_ok else torch.float32
        pipe = StableDiffusionXLPipeline.from_pretrained(str(model_dir), torch_dtype=dtype)
        if gpu_ok:
            pipe, _acc, dev_label = move_module_to_device(pipe, want_gpu=True)
            label = f"qwen_tts_gui parity (SDXL, {dev_label})"
        else:
            label = "qwen_tts_gui parity (SDXL, CPU)"
        if hasattr(pipe, "set_progress_bar_config"):
            try:
                pipe.set_progress_bar_config(disable=_disable_diffusers_tqdm(), leave=False)
            except Exception:  # noqa: BLE001
                pass
        return pipe, label
    except Exception:
        after_use(reason="load_sdxl_standalone_parity_failed")
        raise


def load_generic_diffusers_pipeline(
    model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool
) -> tuple[Any, str]:
    """Load any text-to-image diffusers pipeline via ``DiffusionPipeline.from_pretrained`` (auto-detected)."""
    from localgen.gpu_runtime import after_use, before_load

    if _sdxl_model_index_class(model_dir) == "StableDiffusionXLPipeline":
        return load_sdxl_pipeline_standalone_parity(model_dir, model_info=model_info, use_gpu=use_gpu)

    try:
        import torch
        from diffusers import DiffusionPipeline
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="image")) from e

    before_load("sd3", reason="load_generic_diffusers_pipeline")
    try:
        dtype = _image_load_dtype(model_info, use_gpu)
        from localgen.attention_backend import load_with_hf_attention, log_flash_attn_probe

        log_flash_attn_probe("image-diffusers")
        pipe, label = load_with_hf_attention(
            DiffusionPipeline.from_pretrained,
            str(model_dir),
            use_gpu=use_gpu,
            component="image-diffusers",
            torch_dtype=dtype,
        )
        return _image_pipeline_on_cuda(
            pipe,
            label,
            model_dir=model_dir,
            torch_dtype=dtype,
            use_gpu=use_gpu,
            component="image-diffusers",
        )
    except Exception:
        after_use(reason="load_generic_diffusers_pipeline_failed")
        raise


_SINGLE_FILE_PIPELINE_CLASSES = {
    "StableDiffusionPipeline",
    "StableDiffusionXLPipeline",
    "StableDiffusion3Pipeline",
}


def load_single_file_pipeline(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
    """
    Load a single ``.safetensors`` / ``.ckpt`` checkpoint via ``from_single_file``.

    Required catalog keys for this engine:
      - ``single_file_class``: name of a diffusers pipeline class
        (e.g. ``"StableDiffusionXLPipeline"``) — controls which architecture is loaded.
      - ``single_file_target``: relative path of the checkpoint inside ``model_dir``
        (e.g. ``"model.safetensors"``).
    """
    from localgen.gpu_runtime import after_use, before_load

    try:
        import diffusers
        import torch
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="image")) from e

    cls_name = str(model_info.get("single_file_class") or "").strip()
    if cls_name not in _SINGLE_FILE_PIPELINE_CLASSES:
        raise RuntimeError(
            f"single_file engine: unsupported pipeline class {cls_name!r}. "
            f"Allowed: {sorted(_SINGLE_FILE_PIPELINE_CLASSES)}"
        )
    pipeline_cls = getattr(diffusers, cls_name, None)
    if pipeline_cls is None:
        raise RuntimeError(f"single_file engine: `diffusers.{cls_name}` is not available in the installed diffusers.")

    target_name = str(model_info.get("single_file_target") or "model.safetensors").strip()
    candidate_names = [target_name]
    if target_name != "model.safetensors":
        candidate_names.append("model.safetensors")
    ckpt_path: Path | None = None
    for name in candidate_names:
        direct = Path(model_dir) / name
        if direct.is_file():
            ckpt_path = direct
            break
        matches = list(Path(model_dir).rglob(name))
        if matches:
            ckpt_path = matches[0]
            break
    if ckpt_path is None:
        raise FileNotFoundError(
            f"single_file engine: checkpoint `{target_name}` not found under `{model_dir}`. "
            f"Re-download the model from the Models panel."
        )

    before_load("sd3", reason="load_single_file_pipeline")
    try:
        dtype = _image_load_dtype(model_info, use_gpu)

        kwargs: dict[str, Any] = {"torch_dtype": dtype}
        # The backend pre-fetches the SDXL config / tokenizer files into a controlled
        # ``local_dir`` (no symlinks) to dodge Windows WinError 1314 and stuffs the path
        # in here. Falls back to HF cache fetch if not present.
        cfg_path = str(model_info.get("_single_file_config_path") or "").strip()
        if cfg_path and Path(cfg_path).is_dir():
            kwargs["config"] = cfg_path
        else:
            cfg_repo = str(model_info.get("config_repo_id") or "").strip()
            if cfg_repo:
                kwargs["config"] = cfg_repo

        from localgen.torch_device import diffusers_accelerator, move_module_to_device

        acc = diffusers_accelerator(want_gpu=use_gpu)
        if cls_name == "StableDiffusionXLPipeline" and _image_inference_standalone_parity():
            if acc != "cpu":
                kwargs["torch_dtype"] = torch.float16
            pipe = pipeline_cls.from_single_file(str(ckpt_path), **kwargs)
            if acc != "cpu":
                pipe, _a, dev_label = move_module_to_device(pipe, want_gpu=use_gpu)
            else:
                dev_label = "CPU"
            if hasattr(pipe, "set_progress_bar_config"):
                try:
                    pipe.set_progress_bar_config(disable=_disable_diffusers_tqdm(), leave=False)
                except Exception:  # noqa: BLE001
                    pass
            return pipe, f"qwen_tts_gui parity (SDXL single-file, {dev_label})"

        pipe = pipeline_cls.from_single_file(str(ckpt_path), **kwargs)
        from localgen.attention_backend import configure_diffusers_pipeline_attention

        root = model_dir if model_dir.is_dir() else None
        pipe, label = _image_pipeline_on_cuda(
            pipe,
            "PyTorch SDPA",
            model_dir=root,
            torch_dtype=dtype,
            use_gpu=use_gpu,
            component="image-single-file",
        )
        if cls_name == "StableDiffusionXLPipeline":
            _apply_sdxl_inference_tweaks(pipe, dtype)
        return pipe, label
    except Exception:
        after_use(reason="load_single_file_pipeline_failed")
        raise


def load_image_pipeline(model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool) -> tuple[Any, str]:
    """
    Dispatch to the right pipeline loader based on the catalog entry's ``engine`` / ``type``.

    Recognized engines:
      - ``"sd3"`` (also matches legacy ``type`` = ``"checkpoint"`` / ``"lora"``) → :func:`load_sd3_pipeline`
      - ``"zimage"``                                  → :func:`load_zimage_pipeline`
      - ``"diffusers_auto"`` (or any other generic)   → :func:`load_generic_diffusers_pipeline`
      - ``"diffusers_single_file"``                   → :func:`load_single_file_pipeline`
    """
    engine = str(model_info.get("engine") or "").strip().lower()
    if not engine:
        legacy = str(model_info.get("type") or "").strip().lower()
        if legacy in ("checkpoint", "lora", "sd3"):
            engine = "sd3"
        elif legacy == "zimage":
            engine = "zimage"
        elif legacy in ("diffusers_auto", "diffusers_generic", "diffusers"):
            engine = "diffusers_auto"
        elif legacy in ("diffusers_single_file", "single_file"):
            engine = "diffusers_single_file"
        else:
            engine = "sd3"

    if engine == "zimage":
        return load_zimage_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)
    if engine in ("diffusers_auto", "diffusers_generic", "diffusers"):
        return load_generic_diffusers_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)
    if engine in ("diffusers_single_file", "single_file"):
        return load_single_file_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)
    return load_sd3_pipeline(model_dir, model_info=model_info, use_gpu=use_gpu)


def _apply_video_pipeline_vram_tweaks(pipe: Any, *, use_gpu: bool, full_gpu: bool = False) -> None:
    """Best-effort VRAM helpers common across diffusers T2V pipelines (CUDA only)."""
    if not use_gpu:
        return
    try:
        from localgen.torch_device import cuda_works

        if not cuda_works():
            return
    except Exception:  # noqa: BLE001
        return
    if not full_gpu:
        if hasattr(pipe, "enable_model_cpu_offload"):
            try:
                pipe.enable_model_cpu_offload()
            except Exception:  # noqa: BLE001
                pass
        elif hasattr(pipe, "enable_sequential_cpu_offload"):
            try:
                pipe.enable_sequential_cpu_offload()
            except Exception:  # noqa: BLE001
                pass
    vae = getattr(pipe, "vae", None)
    if vae is not None and hasattr(vae, "enable_tiling"):
        try:
            vae.enable_tiling()
        except Exception:  # noqa: BLE001
            pass


def load_generic_diffusers_video_pipeline(
    model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool, full_gpu: bool = False
) -> tuple[Any, str]:
    """Load any diffusers text-to-video pipeline via ``DiffusionPipeline.from_pretrained``."""
    from localgen.gpu_runtime import after_use, before_load

    try:
        import torch
        from diffusers import DiffusionPipeline
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="video")) from e

    before_load("sd3", reason="load_generic_diffusers_video_pipeline")
    try:
        dtype = _resolve_torch_dtype(str(model_info.get("default_dtype") or "bfloat16"))
        pipe, label = load_with_hf_attention(
            DiffusionPipeline.from_pretrained,
            str(model_dir),
            use_gpu=use_gpu,
            component="video-diffusers",
            torch_dtype=dtype,
        )
        _apply_video_pipeline_vram_tweaks(pipe, use_gpu=use_gpu, full_gpu=full_gpu)
        from localgen.torch_device import cuda_works, diffusers_accelerator, effective_use_gpu, move_module_to_device

        if effective_use_gpu(use_gpu) and full_gpu and hasattr(pipe, "to") and not hasattr(pipe, "_hf_hook"):
            acc = diffusers_accelerator(want_gpu=True)
            if acc == "cuda" and cuda_works():
                try:
                    pipe = pipe.to("cuda")
                except Exception:  # noqa: BLE001
                    pass
            elif acc == "directml":
                pipe, _a, dev_label = move_module_to_device(pipe, want_gpu=True)
                label = f"{label} ({dev_label})"
        elif effective_use_gpu(use_gpu) and not full_gpu:
            acc = diffusers_accelerator(want_gpu=True)
            if acc == "directml" and not hasattr(pipe, "_hf_hook"):
                pipe, _a, dev_label = move_module_to_device(pipe, want_gpu=True)
                label = f"{label} ({dev_label})"
        return pipe, label
    except Exception:
        after_use(reason="load_generic_diffusers_video_pipeline_failed")
        raise


def load_video_pipeline(
    model_dir: Path, *, model_info: dict[str, Any], use_gpu: bool, full_gpu: bool = False
) -> tuple[Any, str]:
    """
    Dispatch video loaders from catalog ``engine`` (default: ``diffusers_auto``).

    Any Hugging Face diffusers repo with ``model_index.json`` under ``video/<org__repo>/`` works.
    """
    engine = str(model_info.get("engine") or model_info.get("type") or "diffusers_auto").strip().lower()
    if engine in ("diffusers_auto", "diffusers_generic", "diffusers", "video"):
        return load_generic_diffusers_video_pipeline(
            model_dir, model_info=model_info, use_gpu=use_gpu, full_gpu=full_gpu
        )
    raise RuntimeError(
        f"Unsupported video engine {engine!r}. Use a diffusers repo (engine=diffusers_auto) or extend the catalog."
    )


def _video_call_kwargs(
    pipe: Any,
    *,
    prompt: str,
    negative_prompt: str | None,
    num_frames: int,
    num_steps: int,
    guidance_scale: float,
    generator: Any,
    height: int | None = None,
    width: int | None = None,
    fps: int | None = None,
    decode_timestep: float | None = None,
    decode_noise_scale: float | None = None,
) -> dict[str, Any]:
    import inspect

    try:
        params = inspect.signature(pipe.__call__).parameters
    except (TypeError, ValueError):
        params = {}

    def pick(*names: str, default: Any = None) -> Any:
        for name in names:
            if name in params:
                return name, default
        return None, None

    out: dict[str, Any] = {"prompt": prompt}
    key, _ = pick("num_frames", "video_length", "num_video_frames")
    if key:
        out[key] = int(num_frames)
    key, _ = pick("num_inference_steps", "steps")
    if key:
        out[key] = int(num_steps)
    key, _ = pick("guidance_scale", "cfg_scale")
    if key and guidance_scale is not None:
        out[key] = float(guidance_scale)
    if negative_prompt:
        key, _ = pick("negative_prompt")
        if key:
            out["negative_prompt"] = negative_prompt
    key, _ = pick("generator")
    if key:
        out["generator"] = generator
    key, _ = pick("height")
    if key and height is not None:
        out[key] = int(height)
    key, _ = pick("width")
    if key and width is not None:
        out[key] = int(width)
    key, _ = pick("frame_rate", "fps")
    if key and fps is not None:
        out[key] = int(fps)
    key, _ = pick("decode_timestep")
    if key and decode_timestep is not None:
        out[key] = float(decode_timestep)
    key, _ = pick("decode_noise_scale")
    if key and decode_noise_scale is not None:
        out[key] = float(decode_noise_scale)
    return out


def _extract_video_frames(result: Any) -> list[Any]:
    """Return a flat list of frames (PIL, ndarray, or tensor slices)."""
    raw: Any = None
    if hasattr(result, "frames") and result.frames:
        raw = result.frames
    elif hasattr(result, "videos") and result.videos:
        raw = result.videos
    elif isinstance(result, (list, tuple)):
        raw = result
    else:
        return [result] if result is not None else []

    # Diffusers T2V: ``frames`` is ``List[List[PIL.Image]]`` — unwrap the batch dimension.
    if isinstance(raw, (list, tuple)) and len(raw) == 1:
        inner = raw[0]
        if isinstance(inner, (list, tuple)):
            raw = inner
        else:
            try:
                import torch

                if isinstance(inner, torch.Tensor):
                    raw = inner
            except ImportError:
                pass

    if isinstance(raw, (list, tuple)):
        if not raw:
            return []
        if isinstance(raw[0], (list, tuple)):
            flat: list[Any] = []
            for chunk in raw:
                if isinstance(chunk, (list, tuple)):
                    flat.extend(chunk)
                else:
                    flat.append(chunk)
            return flat
        return list(raw)

    try:
        import torch

        if isinstance(raw, torch.Tensor):
            t = raw.detach().cpu()
            if t.dim() == 5:
                t = t[0]
            if t.dim() == 4:
                import numpy as np

                arr = t.float().numpy()
                if arr.max() <= 1.0:
                    arr = (arr * 255.0).clip(0, 255).astype(np.uint8)
                else:
                    arr = arr.clip(0, 255).astype(np.uint8)
                if arr.shape[1] in (1, 3, 4):
                    return [arr[i].transpose(1, 2, 0) for i in range(arr.shape[0])]
                return [arr[i] for i in range(arr.shape[0])]
    except ImportError:
        pass

    return [raw]


def _export_video_mp4(frames: Any, out_path: Path, fps: int) -> None:
    """Encode frame list to MP4 — imageio+ffmpeg first (works in packaged installs)."""
    frame_list = _extract_video_frames(frames) if not isinstance(frames, list) else frames
    if not frame_list:
        raise RuntimeError("Video pipeline returned no frames")
    path = str(out_path)
    last_err: Exception | None = None
    try:
        import numpy as np
        import imageio.v3 as iio

        stacked = np.stack([np.asarray(f) for f in frame_list], axis=0)
        iio.imwrite(path, stacked, fps=int(fps), codec="libx264")
        return
    except ImportError as e:
        last_err = e
    except Exception as e:  # noqa: BLE001
        last_err = e

    try:
        from diffusers.utils import export_to_video

        export_to_video(frame_list, path, fps=int(fps))
        return
    except ImportError as e:
        last_err = e
    except Exception as e:  # noqa: BLE001
        last_err = e

    hint = (
        "Video export requires imageio + imageio-ffmpeg (or opencv-python-headless). "
        "Run Settings → Python setup (content profile) to install generation_models[video]."
    )
    if last_err is not None:
        raise RuntimeError(f"{hint} ({last_err})") from last_err
    raise RuntimeError(hint)


def generate_video_file(
    pipe: Any,
    *,
    prompt: str,
    negative_prompt: str | None,
    num_frames: int,
    num_steps: int,
    guidance_scale: float,
    seed: int,
    out_path: Path,
    fps: int,
    height: int | None = None,
    width: int | None = None,
    decode_timestep: float | None = None,
    decode_noise_scale: float | None = None,
) -> None:
    """Run T2V inference and write an MP4 to ``out_path`` (pipeline-agnostic)."""
    import sys

    try:
        import torch
    except ImportError as e:
        raise RuntimeError(_extras_install_hint(profile="video")) from e

    from localgen.torch_device import effective_use_gpu, resolve_generator_device

    device = resolve_generator_device(pipe, want_gpu=effective_use_gpu(True))
    generator = torch.Generator(device=device).manual_seed(int(seed))
    call_kwargs = _video_call_kwargs(
        pipe,
        prompt=prompt,
        negative_prompt=negative_prompt,
        num_frames=num_frames,
        num_steps=num_steps,
        guidance_scale=guidance_scale,
        generator=generator,
        height=height,
        width=width,
        fps=fps,
        decode_timestep=decode_timestep,
        decode_noise_scale=decode_noise_scale,
    )

    print(
        f"localgen.video: generating {num_frames} frames, {num_steps} steps ({list(call_kwargs.keys())})",
        file=sys.stderr,
        flush=True,
    )
    with torch.inference_mode():
        result = pipe(**call_kwargs)
    frames = _extract_video_frames(result)
    _export_video_mp4(frames, out_path, fps)
    print(f"localgen.video: saved {out_path.name}", file=sys.stderr, flush=True)
