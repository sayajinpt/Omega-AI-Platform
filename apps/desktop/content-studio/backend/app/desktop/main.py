from __future__ import annotations

import os
import sys

from PyQt6.QtWidgets import QApplication

from app.desktop.desktop_models_settings import (
    apply_saved_agent_webhook_to_environ,
    apply_saved_hf_token_to_environ,
    apply_saved_tavily_to_environ,
    load_saved_models_data_dir,
)
from app.desktop.theme import apply_app_theme
from app.desktop.local_profile import get_or_create_local_user
from app.desktop.main_window import MainWindow
from app.workers.queue import shutdown_job_executor


def main() -> int:
    saved_models_dir = load_saved_models_data_dir()
    if saved_models_dir:
        os.environ["GENERATION_MODELS_DATA_DIR"] = saved_models_dir
    elif not (os.environ.get("GENERATION_MODELS_DATA_DIR") or "").strip():
        from pathlib import Path

        from app.config import settings

        os.environ["GENERATION_MODELS_DATA_DIR"] = str(
            Path(settings.generation_models_data_dir).expanduser().resolve()
        )
    apply_saved_hf_token_to_environ()
    apply_saved_tavily_to_environ()
    apply_saved_agent_webhook_to_environ()

    app = QApplication(sys.argv)
    app.setApplicationName("YouTube Automation")
    apply_app_theme(app)

    user = get_or_create_local_user()
    win = MainWindow(user)
    win.show()
    code = app.exec()
    shutdown_job_executor(wait=True)
    return int(code) if code is not None else 0
