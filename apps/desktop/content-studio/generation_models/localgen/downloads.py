import json
import shutil
import threading
import time
from pathlib import Path

from huggingface_hub import snapshot_download

from localgen.hf_auth import hf_token_argument

PROGRESS_LINE_PREFIX = "OMEGA_DL_PROGRESS "


# Index-style entry points (small JSON files) — presence alone is enough to call the
# download complete because these files anchor a real diffusers / transformers layout.
_INDEX_ENTRY_FILES = (
    "model_index.json",   # diffusers multi-folder pipelines (SD3, Z-Image, …)
    "config.json",        # transformers / single-model HF
)

# Weight-style entry points — presence alone is NOT enough; the file must also pass the
# minimum-size guard (defends against LFS pointer files / partial downloads).
_WEIGHT_ENTRY_FILES = (
    "diffusion_pytorch_model.safetensors",
    "diffusion_pytorch_model.bin",
    "model.safetensors",
    "pytorch_model.bin",
)
# Allow ANY top-level real weight file as an entry point too (covers InterDiffusion-style
# repos that ship something like ``InterDiffusion-2.5.safetensors``).
_WEIGHT_ENTRY_SUFFIXES = (".safetensors", ".ckpt")

# Real model weights are at minimum hundreds of MB. Anything smaller looks like an LFS
# pointer / partial download and should not be treated as "complete".
_MIN_WEIGHT_BYTES = 100 * 1024 * 1024
# Entire snapshot must exceed this (config-only partial HF fetches are often <20 MB).
_MIN_SNAPSHOT_BYTES = 80 * 1024 * 1024

# Hugging Face hub cache under ``local_dir/.cache`` — bytes here are not usable weights yet.
_SKIP_DIR_NAMES = frozenset({".cache", "blobs", "refs"})


def _skip_dir_name(name: str) -> bool:
    return not name or name.startswith(".") or name in _SKIP_DIR_NAMES


def _folder_total_bytes(local_dir: Path, depth: int = 0) -> int:
    if depth > 8 or not local_dir.is_dir():
        return 0
    total = 0
    try:
        for e in local_dir.iterdir():
            if e.is_file():
                try:
                    total += e.stat().st_size
                except OSError:
                    continue
            elif e.is_dir() and not _skip_dir_name(e.name):
                total += _folder_total_bytes(e, depth + 1)
    except OSError:
        pass
    return total


def _has_incomplete_hf_download(local_dir: Path) -> bool:
    """True when HF hub left ``*.incomplete`` blobs under ``.cache/huggingface/download``."""
    cache = local_dir / ".cache" / "huggingface" / "download"
    if not cache.is_dir():
        return False
    try:
        for p in cache.rglob("*"):
            if p.is_file() and p.name.endswith(".incomplete"):
                return True
    except OSError:
        pass
    return False


def _has_usable_weight_file(local_dir: Path) -> bool:
    """At least one real checkpoint outside ``.cache`` (not an LFS pointer)."""
    if not local_dir.is_dir():
        return False
    weight_names = {n.lower() for n in _WEIGHT_ENTRY_FILES}
    queue: list[tuple[Path, int]] = [(local_dir, 0)]
    while queue:
        node, depth = queue.pop(0)
        try:
            entries = list(node.iterdir())
        except OSError:
            continue
        for e in entries:
            if not e.is_file():
                continue
            lname = e.name.lower()
            is_weight = lname in weight_names or e.suffix.lower() in _WEIGHT_ENTRY_SUFFIXES
            if not is_weight:
                continue
            try:
                if e.stat().st_size >= _MIN_WEIGHT_BYTES:
                    return True
            except OSError:
                continue
        if depth >= 6:
            continue
        for e in entries:
            if e.is_dir() and not _skip_dir_name(e.name):
                queue.append((e, depth + 1))
    return False


def _has_model_index(local_dir: Path, max_depth: int = 3) -> bool:
    if not local_dir.is_dir():
        return False
    queue: list[tuple[Path, int]] = [(local_dir, 0)]
    while queue:
        node, depth = queue.pop(0)
        try:
            entries = list(node.iterdir())
        except OSError:
            continue
        if any(e.is_file() and e.name == "model_index.json" for e in entries):
            return True
        if depth >= max_depth:
            continue
        for e in entries:
            if e.is_dir() and not _skip_dir_name(e.name):
                queue.append((e, depth + 1))
    return False


def snapshot_ready(local_dir: Path, *, kind: str | None = None) -> bool:
    """True when ``local_dir`` holds deployable weights (not just HF metadata / cache blobs)."""
    if not local_dir.is_dir() or _has_incomplete_hf_download(local_dir):
        return False
    if not _has_usable_weight_file(local_dir):
        return False
    if kind == "video":
        return _has_model_index(local_dir)
    return _folder_total_bytes(local_dir) >= _MIN_SNAPSHOT_BYTES


def _prepare_snapshot_dest(local_dir: Path) -> None:
    """
    Reset poisoned partial snapshots before ``snapshot_download``.

    Hugging Face resume breaks when ``model_index.json`` and small configs are already present
    but weight shards only exist as ``.cache/huggingface/download/*.incomplete`` (common when
    the Omega download subprocess is killed mid-transfer — e.g. app closed on Windows). The hub
    then often returns without copying weights into ``vae/``, ``transformer/``, etc.
    """
    if not local_dir.is_dir():
        return
    if snapshot_ready(local_dir):
        return
    cache = local_dir / ".cache"
    if cache.is_dir():
        shutil.rmtree(cache, ignore_errors=True)
    if _has_usable_weight_file(local_dir) and not _has_incomplete_hf_download(local_dir):
        return
    shutil.rmtree(local_dir, ignore_errors=True)


def estimate_repo_bytes(repo_id: str) -> int:
    """Sum sibling file sizes from the HF API (best-effort total for progress UI)."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().repo_info(repo_id, repo_type="model", files_metadata=True)
        total = 0
        for sibling in info.siblings or []:
            size = getattr(sibling, "size", None)
            if size:
                total += int(size)
        return total
    except Exception:
        return 0


def emit_download_progress(bytes_done: int, bytes_total: int, speed_bps: int = 0) -> None:
    """Line-delimited JSON progress for the Omega runtime subprocess reader (stdout, unbuffered)."""
    payload = {
        "bytes_done": max(0, int(bytes_done)),
        "bytes_total": max(0, int(bytes_total)),
        "speed_bps": max(0, int(speed_bps)),
    }
    print(PROGRESS_LINE_PREFIX + json.dumps(payload, separators=(",", ":")), flush=True)


def _snapshot_progress_loop(local_dir: Path, stop: threading.Event, bytes_total: int) -> None:
    prev_bytes = 0
    prev_time = time.monotonic()
    while not stop.wait(0.4):
        done = _folder_total_bytes(local_dir)
        now = time.monotonic()
        dt = max(now - prev_time, 1e-3)
        speed = int(max(0, done - prev_bytes) / dt)
        emit_download_progress(done, bytes_total or done, speed)
        prev_bytes = done
        prev_time = now


def _make_hf_tqdm_class(bytes_total: int):
    from huggingface_hub.utils import tqdm as hf_tqdm

    lock = threading.Lock()
    bars: dict[int, tuple[int, int | None]] = {}
    last_emit = 0.0
    last_done = 0

    class OmegaHubTqdm(hf_tqdm):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            with lock:
                bars[id(self)] = (0, self.total)

        def update(self, n=1):
            result = super().update(n)
            with lock:
                bars[id(self)] = (self.n, self.total)
                done = sum(v[0] for v in bars.values())
                bar_total = sum(v[1] or 0 for v in bars.values())
            total = bytes_total or bar_total or done
            nonlocal last_emit, last_done
            now = time.monotonic()
            speed = 0
            if now - last_emit >= 0.35:
                dt = max(now - last_emit, 1e-3)
                speed = int(max(0, done - last_done) / dt)
                emit_download_progress(done, total, speed)
                last_emit = now
                last_done = done
            return result

        def close(self):
            with lock:
                bars.pop(id(self), None)
            return super().close()

    return OmegaHubTqdm


def _has_entry_point(local_dir: Path) -> bool:
    if not local_dir.is_dir():
        return False
    if _has_incomplete_hf_download(local_dir):
        return False
    return _has_usable_weight_file(local_dir)


_DEFAULT_CONFIG_PATTERNS = (
    "model_index.json",
    "**/*.json",
    "**/*.txt",
    "**/*.model",
    "**/special_tokens_map*",
    "**/tokenizer*",
)


def download_config_only_snapshot(
    repo_id: str,
    local_dir: Path,
    *,
    allow_patterns: tuple[str, ...] | None = None,
) -> Path:
    """
    Fetch ONLY the config / tokenizer files from ``repo_id`` into ``local_dir`` (no weights).

    Uses ``local_dir_use_symlinks=False`` so the result is a flat directory of real files —
    this avoids ``WinError 1314`` ("A required privilege is not held by the client") that
    Windows raises when ``huggingface_hub`` tries to create the cache symlink layout without
    Administrator or Developer Mode privileges. The resulting directory can be passed as
    ``config=`` to ``DiffusionPipeline.from_single_file`` to satisfy its config dependency.
    """
    local_dir = Path(local_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(local_dir),
        max_workers=4,
        token=hf_token_argument(),
        allow_patterns=list(allow_patterns or _DEFAULT_CONFIG_PATTERNS),
    )
    return local_dir


def download_snapshot(repo_id: str, local_dir: Path) -> Path:
    """
    Download a Hugging Face repo snapshot into ``local_dir`` (resumable).

    After ``snapshot_download`` returns, verify the destination actually contains a usable
    entry-point file (``model_index.json``, ``config.json``, or a top-level weights file).
    If not, raise ``RuntimeError`` instead of silently returning — that way the caller (UI
    or batch) can warn the user before any generation job tries to load the broken folder.
    """
    local_dir = Path(local_dir)
    _prepare_snapshot_dest(local_dir)
    local_dir.mkdir(parents=True, exist_ok=True)
    bytes_total = estimate_repo_bytes(repo_id)
    stop_progress = threading.Event()
    progress_thread = threading.Thread(
        target=_snapshot_progress_loop,
        args=(local_dir, stop_progress, bytes_total),
        daemon=True,
    )
    progress_thread.start()
    emit_download_progress(0, bytes_total, 0)
    try:
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(local_dir),
            local_dir_use_symlinks=False,
            max_workers=4,
            token=hf_token_argument(),
            tqdm_class=_make_hf_tqdm_class(bytes_total),
        )
    finally:
        stop_progress.set()
        progress_thread.join(timeout=2.0)
    total_bytes = _folder_total_bytes(local_dir)
    emit_download_progress(total_bytes, bytes_total or total_bytes, 0)
    if _has_incomplete_hf_download(local_dir):
        raise RuntimeError(
            f"Download of '{repo_id}' was interrupted — incomplete weight files remain in "
            f"{local_dir / '.cache'}. Delete {local_dir} and retry from the Models panel."
        )
    if total_bytes < _MIN_SNAPSHOT_BYTES:
        mb = total_bytes // (1024 * 1024)
        min_mb = _MIN_SNAPSHOT_BYTES // (1024 * 1024)
        raise RuntimeError(
            f"Download of '{repo_id}' looks incomplete ({mb} MB on disk, expected ≥{min_mb} MB). "
            f"Delete {local_dir} and retry. Check network, Hugging Face token (Settings), and "
            "that the repo is public or you accepted its license."
        )
    if not _has_entry_point(local_dir):
        entry_names = ", ".join(_INDEX_ENTRY_FILES + _WEIGHT_ENTRY_FILES)
        min_mb = _MIN_WEIGHT_BYTES // (1024 * 1024)
        raise RuntimeError(
            f"Download of '{repo_id}' finished but no usable weight files "
            f"({entry_names}, or any *.safetensors / *.ckpt ≥ {min_mb} MB) were copied "
            f"into {local_dir}. The download may have been interrupted, the HF account "
            "may lack access to the repo, or the model uses a non-standard layout. "
            "Retry the download from the Models panel."
        )
    return local_dir
