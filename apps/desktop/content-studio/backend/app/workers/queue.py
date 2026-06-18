"""Background pipeline jobs — subprocess isolation for fast cancel and clean VRAM."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.config import settings

_executor: ThreadPoolExecutor | None = None
_procs: dict[str, subprocess.Popen[bytes]] = {}
_thread_jobs: set[str] = set()
_force_idle_jobs: set[str] = set()
_procs_lock = threading.Lock()


def force_mark_worker_idle(job_id: str) -> None:
    """After user cancel + GPU unload, treat the job as idle for status/polling (thread may still exit)."""
    jid = job_id.strip()
    if not jid:
        return
    with _procs_lock:
        _force_idle_jobs.add(jid)


def clear_force_idle(job_id: str) -> None:
    jid = job_id.strip()
    with _procs_lock:
        _force_idle_jobs.discard(jid)


def _use_subprocess_jobs() -> bool:
    raw = os.environ.get("OMEGA_CS_JOB_SUBPROCESS", "0").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _kill_process_tree(proc: subprocess.Popen[bytes]) -> None:
    """Hard-stop a pipeline child (Windows needs /T or CUDA keeps running)."""
    pid = proc.pid
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            check=False,
        )
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            pass
        return
    try:
        proc.terminate()
        try:
            proc.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5.0)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[1]


def get_job_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        workers = max(1, min(settings.max_concurrent_jobs, 32))
        _executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="yta_job_")
    return _executor


def shutdown_job_executor(*, wait: bool = False) -> None:
    global _executor
    kill_all_pipeline_jobs()
    if _executor is not None:
        _executor.shutdown(wait=wait, cancel_futures=False)
        _executor = None


def is_pipeline_worker_running(job_id: str) -> bool:
    """True while a subprocess or in-process thread is still executing the job."""
    jid = job_id.strip()
    with _procs_lock:
        if jid in _force_idle_jobs:
            return False
        proc = _procs.get(jid)
        if proc is not None and proc.poll() is None:
            return True
        if jid in _thread_jobs:
            return True
    try:
        from app.services.worker_registry import job_has_live_worker

        return job_has_live_worker(jid)
    except Exception:  # noqa: BLE001
        return False


def any_pipeline_worker_running() -> bool:
    """True while any pipeline subprocess or in-process worker thread is active."""
    with _procs_lock:
        if any(p.poll() is None for p in _procs.values()):
            return True
        active_threads = _thread_jobs - _force_idle_jobs
        if active_threads:
            return True
    try:
        from app.services.worker_registry import any_live_worker_pid_files

        return any_live_worker_pid_files()
    except Exception:  # noqa: BLE001
        return False


def kill_pipeline_job(job_id: str) -> bool:
    """Terminate the child process for a job (immediate stop vs waiting for one diffusion step)."""
    jid = job_id.strip()
    with _procs_lock:
        proc = _procs.get(jid)
    if proc is None or proc.poll() is not None:
        try:
            from app.services.worker_registry import kill_worker_by_job_id

            return kill_worker_by_job_id(jid)
        except Exception:  # noqa: BLE001
            return False
    try:
        _kill_process_tree(proc)
    except Exception:  # noqa: BLE001
        pass
    with _procs_lock:
        _procs.pop(jid, None)
    try:
        from app.services.pipeline_warm_cache import clear_warm_image_pipeline

        clear_warm_image_pipeline()
    except Exception:  # noqa: BLE001
        pass
    return True


def kill_all_pipeline_jobs() -> None:
    with _procs_lock:
        ids = list(_procs.keys())
    for jid in ids:
        kill_pipeline_job(jid)


def _watch_subprocess(job_id: str, proc: subprocess.Popen[bytes]) -> None:
    proc.wait()
    with _procs_lock:
        _procs.pop(job_id, None)
    try:
        from app.database import SessionLocal
        from app.models import Job
        from app.models.enums import JobStatus
        from app.services.agent_webhooks import notify_agent_job_finished

        db = SessionLocal()
        try:
            job = db.get(Job, job_id)
            if job and job.status in (JobStatus.succeeded, JobStatus.failed, JobStatus.cancelled):
                notify_agent_job_finished(job_id)
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        pass


_TQDM_STDERR = re.compile(r"\d+%\|")
_LOCALGEN_STDERR = re.compile(r"localgen\.", re.I)


def _forward_worker_stderr_line(line: str) -> bool:
    """
    Only forward high-signal lines to the API parent.

    diffusers/tqdm spam (often with ``\\r``) filled the pipe → Electron debugLog → IPC and
    **blocked** the worker on ``stderr.write`` (same GPU work as standalone, ~100× slower).
    """
    if _LOCALGEN_STDERR.search(line):
        return True
    if "ERROR:" in line or "Traceback" in line or "Exception in" in line:
        return True
    if _TQDM_STDERR.search(line):
        return False
    if "Loading pipeline components" in line:
        return False
    if "|" in line and ("/it" in line or "it/s" in line):
        return False
    return False


def _drain_subprocess_stderr(proc: subprocess.Popen[bytes], job_id: str) -> None:
    """Drain child stderr so tqdm cannot block the worker; forward only ``localgen.*`` lines."""
    if proc.stderr is None:
        return

    def _read() -> None:
        try:
            for raw in iter(proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").strip()
                if line and _forward_worker_stderr_line(line):
                    print(line, file=sys.stderr, flush=True)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=_read, name=f"yta_job_{job_id[:8]}_stderr", daemon=True).start()


def _invoke_detached_workers() -> bool:
    """Short-lived cs_invoke parent must spawn workers that survive after it exits."""
    return os.environ.get("OMEGA_CS_INVOKE", "").strip() == "1"


def _worker_log_path(job_id: str) -> Path:
    from app.services.worker_registry import _workers_dir

    return _workers_dir() / f"{job_id}.log"


def _worker_creation_flags(*, detached: bool) -> int:
    if sys.platform != "win32":
        return 0
    new_group = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
    if not detached:
        return new_group
    flags = new_group
    flags |= getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return flags


def _submit_subprocess(job_id: str) -> str:
    backend = _backend_dir()
    gen_pkg = backend.parent / "generation_models"
    from app.services.runtime_credentials import overlay_to_env

    env = overlay_to_env(os.environ.copy())
    sep = os.pathsep
    py_path = [str(gen_pkg), str(backend)]
    if env.get("PYTHONPATH"):
        py_path.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = sep.join(py_path)
    env["OMEGA_CS_JOB_SUBPROCESS"] = "0"
    env["OMEGA_CS_WORKER"] = "1"
    env["OMEGA_CS_DISABLE_TQDM"] = "1"
    if "OMEGA_CS_IMAGE_VRAM_MODE" not in env:
        env["OMEGA_CS_IMAGE_VRAM_MODE"] = "all_gpu"
    env.setdefault("OMEGA_CS_IMAGE_STANDALONE_PARITY", "1")

    detached = _invoke_detached_workers()
    log_path = _worker_log_path(job_id)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(log_path, "a", encoding="utf-8")  # noqa: SIM115
    log_file.write(f"\n--- worker start job={job_id} detached={detached} ---\n")
    log_file.flush()

    cmd = [sys.executable, "-m", "app.workers.run_job", job_id]
    popen_kw: dict = {
        "cwd": str(backend),
        "env": env,
        "stdout": log_file,
        "stderr": subprocess.STDOUT,
    }
    if sys.platform == "win32":
        popen_kw["creationflags"] = _worker_creation_flags(detached=detached)
    elif detached:
        popen_kw["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kw)  # noqa: S603
    log_file.close()

    if detached:
        from app.services.worker_registry import _workers_dir

        (_workers_dir() / f"{job_id}.pid").write_text(str(proc.pid), encoding="utf-8")
        # Parent (cs_invoke) exits immediately — track via PID file + DB only.
        return f"detached:{job_id}"

    _drain_subprocess_stderr(proc, job_id)
    with _procs_lock:
        _procs[job_id] = proc
    threading.Thread(
        target=_watch_subprocess,
        args=(job_id, proc),
        name=f"yta_job_{job_id[:8]}",
        daemon=True,
    ).start()
    return f"subprocess:{job_id}"


def submit_pipeline_job(job_id: str) -> str:
    """Queue a pipeline job. Default: isolated subprocess (CUDA context parity with qwen_tts_gui)."""
    if _use_subprocess_jobs():
        return _submit_subprocess(job_id)
    from app.workers.tasks import _run_job

    jid = job_id.strip()
    with _procs_lock:
        _thread_jobs.add(jid)

    def _thread_wrapper() -> None:
        os.environ["OMEGA_CS_WORKER"] = "1"
        os.environ["OMEGA_CS_DISABLE_TQDM"] = "1"
        if "OMEGA_CS_IMAGE_VRAM_MODE" not in os.environ:
            os.environ["OMEGA_CS_IMAGE_VRAM_MODE"] = "all_gpu"
        os.environ.setdefault("OMEGA_CS_IMAGE_STANDALONE_PARITY", "1")
        try:
            _run_job(jid)
        finally:
            with _procs_lock:
                _thread_jobs.discard(jid)
                _force_idle_jobs.discard(jid)
            try:
                from app.services.agent_webhooks import notify_agent_job_finished

                notify_agent_job_finished(jid)
            except Exception:  # noqa: BLE001
                pass

    get_job_executor().submit(_thread_wrapper)
    return f"thread:{job_id}"
