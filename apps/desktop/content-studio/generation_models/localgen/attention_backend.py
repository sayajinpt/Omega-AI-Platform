"""
GPU attention backend selection for Content Studio (PyTorch / Hugging Face / diffusers).

Strategy:
  - Transformers / UNet loads: ``attn_implementation='flash_attention_2'`` when flash-attn is installed.
  - SDXL / SD1.5 *pipelines* ignore pipeline-level ``attn_implementation`` — reload ``unet/`` with flash
    or apply ``AttnProcessor2_0`` (PyTorch SDPA) on the live pipeline.
  - On CPU / without flash wheel: SDPA processors or plain load.

Omega desktop **chat** uses llama.cpp (GGUF), not this module — flash-attn is not applicable there.
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path
from typing import Any, Callable, TypeVar

T = TypeVar("T")

_CONFIGURED = False
_DLL_PATHS_CONFIGURED = False
_FLASH_IMPORT_ERROR: str | None = None


def ensure_cuda_dll_paths() -> None:
    """
    Windows: flash-attn imports ``flash_attn_2_cuda`` which needs CUDA/cuDNN DLLs on PATH.

    Omega's Content Studio worker often lacks the same PATH as a manual venv shell; add
    torch + NVIDIA wheel ``bin`` dirs before testing flash-attn (matches standalone behavior).
    """
    global _DLL_PATHS_CONFIGURED
    if _DLL_PATHS_CONFIGURED:
        return
    _DLL_PATHS_CONFIGURED = True
    if os.name != "nt":
        return
    dirs: list[Path] = []
    try:
        import torch

        torch_lib = Path(torch.__file__).resolve().parent / "lib"
        if torch_lib.is_dir():
            dirs.append(torch_lib)
    except Exception:  # noqa: BLE001
        pass
    site_roots: list[Path] = []
    try:
        import site

        site_roots.extend(Path(p) for p in site.getsitepackages())
    except Exception:  # noqa: BLE001
        pass
    try:
        cs_root = Path(__file__).resolve().parents[2]
        if sys.platform == "win32":
            venv_site = cs_root / "backend" / ".venv" / "Lib" / "site-packages"
        else:
            ver = f"{sys.version_info.major}.{sys.version_info.minor}"
            venv_site = cs_root / "backend" / ".venv" / "lib" / f"python{ver}" / "site-packages"
        if venv_site.is_dir():
            site_roots.append(venv_site)
    except Exception:  # noqa: BLE001
        pass
    nvidia_rels = (
        "nvidia/cuda_runtime/bin",
        "nvidia/cublas/bin",
        "nvidia/cudnn/bin",
        "nvidia/cufft/bin",
        "nvidia/curand/bin",
        "nvidia/cusolver/bin",
        "nvidia/cusparse/bin",
        "nvidia/nvjitlink/bin",
    )
    for root in site_roots:
        for rel in nvidia_rels:
            p = root / rel
            if p.is_dir():
                dirs.append(p)
    path_parts: list[str] = []
    seen_path: set[str] = set()
    for d in dirs:
        s = str(d)
        if s not in seen_path:
            seen_path.add(s)
            path_parts.append(s)
        try:
            os.add_dll_directory(s)
        except Exception:  # noqa: BLE001
            pass
    if path_parts:
        rest = os.environ.get("PATH", "")
        os.environ["PATH"] = os.pathsep.join(path_parts) + (os.pathsep + rest if rest else "")


def configure_pytorch_sdp_backends() -> None:
    """Let PyTorch SDPA pick flash / mem-efficient kernels when flash-attn is not wired explicitly."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True
    try:
        import torch

        if not torch.cuda.is_available():
            return
        if hasattr(torch.backends, "cuda") and hasattr(torch.backends.cuda, "enable_flash_sdp"):
            torch.backends.cuda.enable_flash_sdp(True)
            torch.backends.cuda.enable_mem_efficient_sdp(True)
            torch.backends.cuda.enable_math_sdp(True)
        if hasattr(torch.backends, "cudnn"):
            # benchmark=True autotunes convs on first forward pass per shape — at 1024² the
            # first SDXL step can sit silent for many minutes (looks hung). Standalone GUI
            # never enables this. Opt in with OMEGA_CUDNN_BENCHMARK=1.
            bench = os.environ.get("OMEGA_CUDNN_BENCHMARK", "0").strip().lower()
            torch.backends.cudnn.benchmark = bench in ("1", "true", "yes", "on")
            if hasattr(torch.backends.cudnn, "allow_tf32"):
                torch.backends.cudnn.allow_tf32 = True
        if hasattr(torch.backends.cuda, "matmul") and hasattr(torch.backends.cuda.matmul, "allow_tf32"):
            torch.backends.cuda.matmul.allow_tf32 = True
    except Exception:  # noqa: BLE001
        pass


def cuda_available() -> bool:
    from localgen.torch_device import cuda_works

    return cuda_works()


def flash_attn_import_error() -> str | None:
    """Last flash-attn import failure (e.g. missing CUDA DLL on Windows)."""
    return _FLASH_IMPORT_ERROR


def flash_attn_installed() -> bool:
    """True when the flash-attn CUDA extension loads (not merely the meta package)."""
    global _FLASH_IMPORT_ERROR
    if not cuda_available():
        return False
    ensure_cuda_dll_paths()
    try:
        import flash_attn  # noqa: F401

        import flash_attn_2_cuda  # noqa: F401

        _FLASH_IMPORT_ERROR = None
        return True
    except ImportError as exc:
        _FLASH_IMPORT_ERROR = str(exc)
        return False
    except OSError as exc:
        _FLASH_IMPORT_ERROR = str(exc)
        return False


def flash_attention_available() -> bool:
    """True when flash-attn is importable and CUDA is available."""
    return flash_attn_installed()


def log_flash_attn_probe(component: str = "attention") -> None:
    """Emit one stderr line when flash-attn is present but cannot load its CUDA extension."""
    ensure_cuda_dll_paths()
    try:
        import importlib.util

        if importlib.util.find_spec("flash_attn") is None:
            return
    except Exception:  # noqa: BLE001
        return
    if flash_attn_installed():
        print(
            f"localgen.{component}: FlashAttention 2 available",
            file=sys.stderr,
            flush=True,
        )
        return
    err = flash_attn_import_error() or "unknown import error"
    print(
        f"localgen.{component}: flash_attn is installed but failed to import: {err}. "
        "Falling back to native PyTorch attention.",
        file=sys.stderr,
        flush=True,
    )


def _env_prefers_flash_attention() -> bool | None:
    """Legacy Omega Settings → ``OMEGA_PREFER_FLASH_ATTENTION`` (1=on, 0=off)."""
    raw = os.environ.get("OMEGA_PREFER_FLASH_ATTENTION", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    return None


def gpu_attention_mode() -> str:
    """
    ``auto`` (default): PyTorch SDPA / diffusers — lets the runtime pick kernels.
    ``flash``: force flash-attn when the wheel loads.
    ``off``: never request flash-attn.
    """
    raw = os.environ.get("OMEGA_GPU_ATTENTION_MODE", "").strip().lower()
    if raw in ("auto", "flash", "off"):
        return raw
    leg = _env_prefers_flash_attention()
    if leg is False:
        return "off"
    if leg is True:
        return "flash"
    return "auto"


def should_prefer_flash_attention(*, use_gpu: bool) -> bool:
    """True only when Settings mode is ``flash`` and the CUDA extension imports."""
    if not use_gpu or not cuda_available():
        return False
    if os.environ.get("OMEGA_DISABLE_FLASH_ATTENTION", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return False
    if gpu_attention_mode() != "flash":
        return False
    return flash_attn_installed()


def should_use_flash_attention_for_images(*, use_gpu: bool) -> bool:
    """
    Image diffusion (SDXL/SD3): use flash-attn when the wheel loads.

    Unlike TTS transformers, ``auto`` mode upgrades to FA2 when available — SDPA-only
    UNet at 1024² on 16 GB cards is often ~15 s/step with tight VRAM.
    """
    if not use_gpu or not cuda_available():
        return False
    if os.environ.get("OMEGA_DISABLE_FLASH_ATTENTION", "").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        return False
    mode = gpu_attention_mode()
    if mode == "off":
        return False
    if mode in ("auto", "flash"):
        return flash_attn_installed()
    return False


def standalone_image_load_enabled() -> bool:
    """
    Dev-only escape hatch: plain ``from_pretrained`` without UNet attention patching.

    Omega desktop never sets this — packaged installs always patch SDXL/SD3 UNet attention automatically.
    """
    raw = os.environ.get("OMEGA_CS_STANDALONE_IMAGE_LOAD", "0").strip().lower()
    return raw in ("1", "true", "yes", "on")


def should_use_flash_image_attention(*, use_gpu: bool) -> bool:
    """Use flash-attn only when Settings mode is ``flash`` and the extension loads."""
    if not use_gpu or gpu_attention_mode() != "flash":
        return False
    return flash_attention_available()


def attention_label(*, on_cuda: bool, used_flash: bool, flash_failed: bool) -> str:
    if used_flash:
        return "FlashAttention 2"
    if flash_failed:
        return "PyTorch SDPA (FlashAttention unavailable, fallback)"
    if on_cuda:
        if gpu_attention_mode() == "auto":
            return "PyTorch SDPA (auto)"
        return "PyTorch SDPA"
    return "PyTorch SDPA (CPU)"


def static_attention_label(*, use_gpu: bool, supports_hf_attn: bool) -> str:
    """Label when flash cannot be requested (e.g. diffusers ``from_single_file``)."""
    on_cuda = bool(use_gpu and cuda_available())
    if not supports_hf_attn:
        if on_cuda and flash_attention_available():
            return "PyTorch SDPA (diffusers default; flash via SDPA backends)"
        if on_cuda:
            return "PyTorch SDPA (diffusers default)"
        return "PyTorch SDPA (CPU)"
    return attention_label(on_cuda=on_cuda, used_flash=False, flash_failed=False)


def log_attention_choice(component: str, label: str) -> None:
    print(f"localgen.{component}: attention backend = {label}", file=sys.stderr, flush=True)


def log_attention_processor_sample(pipe: Any, component: str) -> None:
    """One-line diagnostic: which attention processor classes are on the UNet."""
    for attr in ("unet", "transformer"):
        mod = getattr(pipe, attr, None)
        procs = getattr(mod, "attn_processors", None) if mod is not None else None
        if not procs:
            continue
        names = sorted({type(p).__name__ for p in procs.values()})
        sample = names[:4]
        extra = f" (+{len(names) - 4} more)" if len(names) > 4 else ""
        print(
            f"localgen.{component}: {attr} attn processors: {', '.join(sample)}{extra}",
            file=sys.stderr,
            flush=True,
        )
        return


def _attn_implementation_ignored(caught: list[warnings.Warning]) -> bool:
    for w in caught:
        msg = str(w.message).lower()
        if "attn_implementation" in msg and "ignored" in msg:
            return True
    return False


def _is_diffusers_pipeline(obj: Any) -> bool:
    """SDXL / SD1.5 / SD3 pipelines expose ``unet`` or ``transformer`` submodules."""
    return hasattr(obj, "unet") or hasattr(obj, "transformer")


def _first_pretrained_path(args: tuple[Any, ...]) -> Path | None:
    if not args:
        return None
    raw = args[0]
    if isinstance(raw, (str, Path)):
        p = Path(raw).expanduser()
        if p.exists() or "/" in str(raw) or "\\" in str(raw):
            return p
    return None


def _has_config_subfolder(model_dir: Path, subfolder: str) -> bool:
    return (model_dir / subfolder / "config.json").is_file()


def _subfolder_pretrained_factory(subfolder: str) -> Callable[..., Any] | None:
    """Map diffusers layout subfolders to the right ``from_pretrained`` class."""
    if subfolder == "unet":
        try:
            from diffusers import UNet2DConditionModel

            return UNet2DConditionModel.from_pretrained
        except ImportError:
            return None
    if subfolder == "transformer":
        try:
            from diffusers import SD3Transformer2DModel

            return SD3Transformer2DModel.from_pretrained
        except ImportError:
            pass
        try:
            from diffusers.models.transformers.transformer_2d import Transformer2DModel

            return Transformer2DModel.from_pretrained
        except ImportError:
            return None
    return None


_SLOW_ATTN_PROCESSOR_NAMES = frozenset({"AttnProcessor", "LoRAAttnProcessor", "LoRAXFormersAttnProcessor"})


def _pipeline_uses_fast_attention(pipe: Any) -> bool:
    """True when UNet/transformer attention is already on SDPA / flash / xFormers processors."""
    for attr in ("unet", "transformer", "transformer_2"):
        mod = getattr(pipe, attr, None)
        if mod is None:
            continue
        procs = getattr(mod, "attn_processors", None) or {}
        if not procs:
            continue
        for proc in procs.values():
            name = type(proc).__name__
            if name in _SLOW_ATTN_PROCESSOR_NAMES:
                return False
        return True
    return False


def _apply_attn_processor2(pipe: Any, *, component: str) -> str:
    """Fast path when UNet flash reload is unavailable (e.g. single-file checkpoints)."""
    from diffusers.models.attention_processor import AttnProcessor2_0

    patched: list[str] = []
    for attr in ("unet", "transformer", "transformer_2"):
        mod = getattr(pipe, attr, None)
        if mod is None:
            continue
        if not hasattr(mod, "set_attn_processor"):
            print(
                f"localgen.{component}: {attr} has no set_attn_processor — skipping SDPA patch",
                file=sys.stderr,
                flush=True,
            )
            continue
        try:
            mod.set_attn_processor(AttnProcessor2_0())
            patched.append(attr)
        except Exception as exc:  # noqa: BLE001
            print(
                f"localgen.{component}: AttnProcessor2_0 on {attr} failed ({exc!r})",
                file=sys.stderr,
                flush=True,
            )
            try:
                procs = {
                    name: AttnProcessor2_0()
                    for name, proc in getattr(mod, "attn_processors", {}).items()
                }
                if procs:
                    mod.set_attn_processor(procs)
                    patched.append(f"{attr}({len(procs)} layers)")
            except Exception as exc2:  # noqa: BLE001
                print(
                    f"localgen.{component}: per-layer AttnProcessor2_0 on {attr} failed ({exc2!r})",
                    file=sys.stderr,
                    flush=True,
                )
    on_cuda = cuda_available()
    if patched:
        auto_tag = "auto, " if gpu_attention_mode() == "auto" else ""
        label = f"PyTorch SDPA ({auto_tag}AttnProcessor2_0 on {', '.join(patched)})"
    elif on_cuda:
        label = "PyTorch SDPA (diffusers default; processor patch skipped)"
    else:
        label = "PyTorch SDPA (CPU)"
    log_attention_choice(component, label)
    return label


def _reload_submodule_with_flash(
    pipe: Any,
    *,
    model_dir: Path,
    subfolder: str,
    attr: str,
    torch_dtype: Any,
    use_gpu: bool,
    component: str,
) -> str | None:
    """Replace ``pipe.unet`` / ``pipe.transformer`` with a submodule loaded using flash-attn."""
    if not _has_config_subfolder(model_dir, subfolder):
        return None
    target = getattr(pipe, attr, None)
    if target is None:
        return None

    factory = _subfolder_pretrained_factory(subfolder)
    if factory is None:
        return None

    try:
        import torch
    except ImportError:
        return None

    device = next(target.parameters()).device if hasattr(target, "parameters") else None
    dtype = torch_dtype
    if dtype is None and device is not None:
        try:
            dtype = next(target.parameters()).dtype
        except StopIteration:
            dtype = torch.float16

    kwargs: dict[str, Any] = {}
    if dtype is not None:
        kwargs["torch_dtype"] = dtype

    try:
        new_mod, label = load_with_hf_attention(
            factory,
            str(model_dir),
            use_gpu=use_gpu,
            prefer_flash=True,
            component=f"{component}-{subfolder}",
            subfolder=subfolder,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001
        print(
            f"localgen.{component}: flash reload `{subfolder}/` failed ({exc!r})",
            file=sys.stderr,
            flush=True,
        )
        return None

    if device is not None and use_gpu:
        from localgen.torch_device import effective_use_gpu, resolve_torch_device

        if effective_use_gpu(use_gpu):
            new_mod = new_mod.to(resolve_torch_device(want_gpu=True))
    setattr(pipe, attr, new_mod)
    return label


def configure_diffusers_pipeline_attention(
    pipe: Any,
    *,
    model_dir: str | Path | None = None,
    torch_dtype: Any = None,
    use_gpu: bool,
    prefer_flash: bool = True,
    component: str = "image-diffusers",
) -> str:
    """
    SDXL / SD1.5 / SD3 pipelines often ignore pipeline-level ``attn_implementation``.
    Reload ``unet/`` or ``transformer/`` with flash when possible; otherwise set SDPA processors.
    """
    configure_pytorch_sdp_backends()
    prefer_fa = prefer_flash and should_use_flash_attention_for_images(use_gpu=use_gpu)
    root = Path(model_dir).expanduser().resolve() if model_dir else None
    # Packaged Omega: try real flash-attn on UNet when installed, else fast SDPA processors (never slow default).
    try_flash_unet_reload = (
        prefer_fa and root is not None and root.is_dir() and flash_attn_installed()
    )

    if try_flash_unet_reload:
        for subfolder, attr in (("unet", "unet"), ("transformer", "transformer")):
            label = _reload_submodule_with_flash(
                pipe,
                model_dir=root,
                subfolder=subfolder,
                attr=attr,
                torch_dtype=torch_dtype,
                use_gpu=use_gpu,
                component=component,
            )
            if label and "FlashAttention 2" in label:
                log_attention_choice(component, label)
                return label

    return _apply_attn_processor2(pipe, component=component)


def _load_diffusers_pipeline_auto(
    factory: Callable[..., T],
    /,
    *args: Any,
    use_gpu: bool,
    component: str,
    model_path: Path | None,
    **kwargs: Any,
) -> tuple[T, str]:
    """
    ``auto`` mode: load with ``attn_implementation='sdpa'`` (PyTorch kernel picker), then
    patch only if legacy slow processors remain. Matches standalone speed without forcing flash-attn.
    """
    configure_pytorch_sdp_backends()
    obj: T | None = None
    label = "PyTorch SDPA (auto)"
    for impl in ("sdpa", None):
        try:
            if impl:
                obj = factory(*args, attn_implementation=impl, **kwargs)
                label = f"PyTorch SDPA (auto, attn_implementation={impl})"
            else:
                obj = factory(*args, **kwargs)
                label = "PyTorch SDPA (auto, native load)"
            break
        except TypeError:
            continue
    if obj is None:
        raise RuntimeError(f"localgen.{component}: pipeline factory failed for auto load")

    if _is_diffusers_pipeline(obj):
        if _pipeline_uses_fast_attention(obj):
            log_attention_choice(component, f"{label}, processors verified")
        else:
            print(
                f"localgen.{component}: slow legacy attention detected after load — applying SDPA processors",
                file=sys.stderr,
                flush=True,
            )
            label = configure_diffusers_pipeline_attention(
                obj,
                model_dir=model_path,
                torch_dtype=kwargs.get("torch_dtype"),
                use_gpu=use_gpu,
                prefer_flash=False,
                component=component,
            )
            if not _pipeline_uses_fast_attention(obj):
                print(
                    f"localgen.{component}: WARNING still on slow attention after patch — "
                    "expect much slower steps than standalone",
                    file=sys.stderr,
                    flush=True,
                )
    else:
        log_attention_choice(component, label)
    return obj, label


def load_with_hf_attention(
    factory: Callable[..., T],
    /,
    *args: Any,
    use_gpu: bool,
    prefer_flash: bool = True,
    component: str = "model",
    **kwargs: Any,
) -> tuple[T, str]:
    """
    Call a Hugging Face ``from_pretrained``-style factory with flash-first ``attn_implementation``.

    When diffusers *pipelines* ignore ``attn_implementation``, patch UNet/transformer attention
    instead of reporting a false "FlashAttention 2" label.
    """
    configure_pytorch_sdp_backends()
    on_cuda = bool(use_gpu and cuda_available())
    flash_failed = False
    model_path = _first_pretrained_path(args)
    mode = gpu_attention_mode()
    want_flash = prefer_flash and mode == "flash" and should_prefer_flash_attention(use_gpu=use_gpu)

    if mode == "auto":
        return _load_diffusers_pipeline_auto(
            factory,
            *args,
            use_gpu=use_gpu,
            component=component,
            model_path=model_path,
            **kwargs,
        )

    if want_flash:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                obj = factory(*args, attn_implementation="flash_attention_2", **kwargs)
                if _is_diffusers_pipeline(obj):
                    if _attn_implementation_ignored(caught):
                        print(
                            f"localgen.{component}: pipeline ignored attn_implementation; "
                            "applying UNet/transformer flash or SDPA processors",
                            file=sys.stderr,
                            flush=True,
                        )
                    else:
                        print(
                            f"localgen.{component}: diffusers pipeline — patching UNet/transformer attention",
                            file=sys.stderr,
                            flush=True,
                        )
                    label = configure_diffusers_pipeline_attention(
                        obj,
                        model_dir=model_path,
                        torch_dtype=kwargs.get("torch_dtype"),
                        use_gpu=use_gpu,
                        prefer_flash=True,
                        component=component,
                    )
                    return obj, label
                label = attention_label(on_cuda=on_cuda, used_flash=True, flash_failed=False)
                log_attention_choice(component, label)
                return obj, label
            except TypeError:
                pass
            except Exception as exc:  # noqa: BLE001
                flash_failed = True
                print(
                    f"localgen.{component}: FlashAttention failed ({exc!r}), retrying with sdpa",
                    file=sys.stderr,
                    flush=True,
                )
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                obj = factory(*args, attn_implementation="sdpa", **kwargs)
                if _is_diffusers_pipeline(obj):
                    label = configure_diffusers_pipeline_attention(
                        obj,
                        model_dir=model_path,
                        torch_dtype=kwargs.get("torch_dtype"),
                        use_gpu=use_gpu,
                        prefer_flash=False,
                        component=component,
                    )
                    return obj, label
                label = attention_label(on_cuda=on_cuda, used_flash=False, flash_failed=flash_failed)
                log_attention_choice(component, label)
                return obj, label
            except TypeError:
                pass
            except Exception:  # noqa: BLE001
                if flash_failed:
                    raise

    obj = factory(*args, **kwargs)
    if _is_diffusers_pipeline(obj):
        label = configure_diffusers_pipeline_attention(
            obj,
            model_dir=model_path,
            torch_dtype=kwargs.get("torch_dtype"),
            use_gpu=use_gpu,
            prefer_flash=prefer_flash,
            component=component,
        )
        return obj, label
    label = attention_label(on_cuda=on_cuda, used_flash=False, flash_failed=flash_failed)
    log_attention_choice(component, label)
    return obj, label


ensure_cuda_dll_paths()
