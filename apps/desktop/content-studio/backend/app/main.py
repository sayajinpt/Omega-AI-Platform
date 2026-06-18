import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.config import settings
from app.database import SessionLocal, engine
from app.models.base import Base
from app.services.schedule_tick import run_schedule_tick
from app.workers.queue import shutdown_job_executor
import app.models.tables  # noqa: F401 — register ORM tables

logger = logging.getLogger(__name__)


def _ensure_database_schema() -> None:
    """Safety net if Alembic did not run (e.g. first Omega launch)."""
    try:
        Base.metadata.create_all(bind=engine)
    except Exception:
        logger.exception("create_all failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Do not import flash_attn / touch CUDA in the API parent — that reserves GPU context and
    # contends with the isolated render worker subprocess (standalone GUI is one process only).
    _ensure_database_schema()
    # Align localgen ``get_models_root()`` with Settings when the env var was never exported
    # (common when only ``generation_models_data_dir`` is set in ``.env``).
    if not (os.environ.get("GENERATION_MODELS_DATA_DIR") or "").strip():
        gm = Path(settings.generation_models_data_dir).expanduser().resolve()
        os.environ["GENERATION_MODELS_DATA_DIR"] = str(gm)
    try:
        from app.services.runtime_credentials import bootstrap_settings_from_env

        bootstrap_settings_from_env()
    except Exception:
        logger.exception("bootstrap_settings_from_env failed")

    stop = threading.Event()
    thread: threading.Thread | None = None

    if settings.api_schedule_runner:

        def _worker() -> None:
            while not stop.wait(60.0):
                db = SessionLocal()
                try:
                    run_schedule_tick(db, user_id=None)
                except Exception:  # noqa: BLE001
                    logger.exception("API schedule tick failed")
                finally:
                    db.close()

        thread = threading.Thread(target=_worker, name="yta_api_schedule", daemon=True)
        thread.start()

    yield

    stop.set()
    if thread is not None:
        thread.join(timeout=6.0)
    shutdown_job_executor(wait=True)


app = FastAPI(title="Media Automation", version="0.4.0", lifespan=lifespan)

origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins
    or [
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix=settings.api_prefix)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
