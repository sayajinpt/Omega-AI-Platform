"""Run one pipeline job in an isolated process (``python -m app.workers.run_job <job_id>``)."""

from __future__ import annotations

import os
import sys

from app.workers.tasks import execute_pipeline_job


def _attach_worker_log(job_id: str) -> None:
    from app.services.worker_registry import _workers_dir

    log_path = _workers_dir() / f"{job_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_file = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = log_file
    sys.stderr = log_file
    print(f"run_job start pid={os.getpid()} job={job_id}", flush=True)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: python -m app.workers.run_job <job_id>")
    from app.services.runtime_credentials import bootstrap_settings_from_env
    from app.services.worker_registry import clear_worker_pid, write_worker_pid

    job_id = sys.argv[1].strip()
    _attach_worker_log(job_id)
    bootstrap_settings_from_env()
    from app.services.omega_debug import emit_debug

    emit_debug(f"run_job start pid={os.getpid()}", data={"job_id": job_id, "pid": os.getpid()})
    write_worker_pid(job_id)
    try:
        execute_pipeline_job(job_id)
        emit_debug("run_job finished", data={"job_id": job_id})
    except Exception as exc:  # noqa: BLE001
        emit_debug(f"run_job failed: {exc}", level="error", data={"job_id": job_id})
        raise
    finally:
        clear_worker_pid(job_id)
        print(f"run_job exit pid={os.getpid()} job={job_id}", flush=True)


if __name__ == "__main__":
    main()
