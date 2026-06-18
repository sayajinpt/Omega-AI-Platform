"""Track pipeline worker PIDs on disk (on-demand mode has no long-lived uvicorn parent)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def _workers_dir() -> Path:
    base = (os.environ.get("OMEGA_CS_STORAGE_PATH") or "").strip()
    if base:
        root = Path(base).parent
    else:
        root = Path(__file__).resolve().parents[2] / "data"
    d = root / "workers"
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_worker_pid(job_id: str) -> None:
    jid = job_id.strip()
    if not jid:
        return
    (_workers_dir() / f"{jid}.pid").write_text(str(os.getpid()), encoding="utf-8")


def clear_worker_pid(job_id: str) -> None:
    jid = job_id.strip()
    if not jid:
        return
    try:
        (_workers_dir() / f"{jid}.pid").unlink(missing_ok=True)
    except OSError:
        pass


def read_worker_pid(job_id: str) -> int | None:
    jid = job_id.strip()
    if not jid:
        return None
    path = _workers_dir() / f"{jid}.pid"
    if not path.is_file():
        return None
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
        return pid if pid > 0 else None
    except (OSError, ValueError):
        return None


def is_worker_pid_alive(pid: int) -> bool:
    """True when ``pid`` refers to a live OS process."""
    return _pid_alive(pid)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            exit_code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            kernel32.CloseHandle(handle)
            if not ok:
                return False
            return exit_code.value == 259  # STILL_ACTIVE
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def prune_stale_worker_pids() -> int:
    """Remove PID files whose process is no longer running. Returns count removed."""
    removed = 0
    try:
        for path in _workers_dir().glob("*.pid"):
            try:
                pid = int(path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            if not _pid_alive(pid):
                path.unlink(missing_ok=True)
                removed += 1
    except OSError:
        pass
    return removed


def any_live_worker_pid_files() -> bool:
    """True when at least one on-disk worker PID file refers to a live process."""
    prune_stale_worker_pids()
    try:
        for path in _workers_dir().glob("*.pid"):
            try:
                pid = int(path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                continue
            if _pid_alive(pid):
                return True
    except OSError:
        return False
    return False


def any_worker_pid_files() -> bool:
    """Backward-compatible alias — only counts live worker processes."""
    return any_live_worker_pid_files()


def _kill_pid_tree(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            check=False,
        )
        return True
    try:
        os.kill(pid, 15)
        return True
    except OSError:
        try:
            os.kill(pid, 9)
            return True
        except OSError:
            return False


def job_has_live_worker(job_id: str) -> bool:
    """True when this job has a live pipeline worker process (on-disk PID file)."""
    jid = job_id.strip()
    if not jid:
        return False
    pid = read_worker_pid(jid)
    return pid is not None and _pid_alive(pid)


def reconcile_orphaned_pipeline_jobs(db) -> int:
    """
    Fail queued/running jobs whose worker process is gone.

    On-demand ``cs_invoke`` creates jobs in a short-lived parent; if a worker fails to
    detach it leaves zombie rows that block ``create-run`` forever.
    """
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.models import Job, JobLog
    from app.models.enums import JobStatus
    from app.workers.queue import is_pipeline_worker_running

    count = 0
    rows = db.execute(
        select(Job).where(Job.status.in_((JobStatus.queued, JobStatus.running)))
    ).scalars().all()
    for job in rows:
        jid = str(job.id)
        if is_pipeline_worker_running(jid):
            continue
        if job_has_live_worker(jid):
            continue
        task_tag = str(getattr(job, "celery_task_id", "") or "")
        grace_sec = 45 if task_tag.startswith("deferred:") else 15
        updated = job.updated_at or job.created_at
        if updated is not None:
            ts = updated if updated.tzinfo else updated.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - ts < timedelta(seconds=grace_sec):
                continue
        clear_worker_pid(jid)
        job.status = JobStatus.failed
        job.updated_at = datetime.now(timezone.utc)
        db.add(job)
        db.add(
            JobLog(
                job_id=job.id,
                level="error",
                message=(
                    "Pipeline worker is not running — job marked failed so a new render can start. "
                    "Check workers/*.log under Content Studio data if this repeats."
                ),
            )
        )
        count += 1
    if count:
        db.commit()
    return count


def kill_worker_by_job_id(job_id: str) -> bool:
    """Terminate a detached pipeline worker if we have its PID."""
    pid = read_worker_pid(job_id)
    if pid is None:
        return False
    ok = _kill_pid_tree(pid)
    clear_worker_pid(job_id)
    return ok
