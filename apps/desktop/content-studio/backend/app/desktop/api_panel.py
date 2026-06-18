"""Local agent API reference and webhook settings for Hermes / other orchestrators."""

from __future__ import annotations

import os
import webbrowser

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QGuiApplication
from PyQt6.QtWidgets import (
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from app.config import settings
from app.desktop.desktop_models_settings import (
    clear_saved_agent_webhook_url,
    load_saved_agent_webhook_url,
    save_agent_webhook_url,
)
from app.desktop.theme import mark_primary


class LocalApiPanel(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        base = "http://127.0.0.1:8000"
        prefix = settings.api_prefix.rstrip("/")

        hero = QLabel("Local agent API")
        hero.setProperty("class", "hero")
        sub = QLabel(
            "Hermes and other tools on this PC can create videos without login. "
            "Start the API server below, then call these endpoints on localhost only."
        )
        sub.setProperty("class", "subtitle")
        sub.setWordWrap(True)

        start_box = QGroupBox("Start server")
        start_lay = QVBoxLayout(start_box)
        cmd = (
            "cd backend\n"
            ".\\.venv\\Scripts\\activate\n"
            "uvicorn app.main:app --host 127.0.0.1 --port 8000"
        )
        start_lay.addWidget(QLabel(f"<code>{cmd.replace(chr(10), '<br/>')}</code>"))
        btn_docs = QPushButton("Open API docs (Swagger)")
        btn_docs.clicked.connect(lambda: webbrowser.open(f"{base}/docs"))
        mark_primary(btn_docs)
        start_lay.addWidget(btn_docs)

        webhook_box = QGroupBox("Completion webhook (optional)")
        wh_lay = QVBoxLayout(webhook_box)
        wh_hint = QLabel(
            "When a pipeline job finishes, the API POSTs JSON to this URL "
            "(event <code>job.finished</code>). Hermes can expose an HTTP listener here."
        )
        wh_hint.setWordWrap(True)
        wh_hint.setTextFormat(Qt.TextFormat.RichText)
        wh_row = QHBoxLayout()
        self._webhook_edit = QLineEdit()
        self._webhook_edit.setPlaceholderText("http://127.0.0.1:9999/youtube-automation/webhook")
        btn_wh_save = QPushButton("Save")
        btn_wh_save.clicked.connect(self._save_webhook)
        btn_wh_clear = QPushButton("Clear")
        btn_wh_clear.clicked.connect(self._clear_webhook)
        wh_row.addWidget(self._webhook_edit)
        wh_row.addWidget(btn_wh_save)
        wh_row.addWidget(btn_wh_clear)
        wh_lay.addWidget(wh_hint)
        wh_lay.addLayout(wh_row)

        ref_box = QGroupBox("Quick reference")
        ref_lay = QVBoxLayout(ref_box)
        example = (
            f"GET  {prefix}/agent/v1/info\n"
            f"POST {prefix}/agent/v1/runs\n"
            f"GET  {prefix}/agent/v1/runs/{{job_id}}\n"
            f"GET  {prefix}/agent/v1/runs/{{job_id}}/content\n"
            f"GET  {prefix}/agent/v1/projects\n"
        )
        self._ref_text = QTextEdit()
        self._ref_text.setReadOnly(True)
        self._ref_text.setMaximumHeight(120)
        self._ref_text.setPlainText(example)
        btn_copy_curl = QPushButton("Copy sample curl (script_only)")
        btn_copy_curl.clicked.connect(self._copy_sample_curl)
        mark_primary(btn_copy_curl)
        ref_lay.addWidget(self._ref_text)
        ref_lay.addWidget(btn_copy_curl)

        sample_box = QGroupBox("Sample POST body")
        sample_lay = QVBoxLayout(sample_box)
        body = (
            "{\n"
            '  "title": "Episode from Hermes",\n'
            '  "theme": "Your channel theme",\n'
            '  "episode_topic": "Specific angle for this video",\n'
            '  "pipeline_mode": "script_only",\n'
            '  "wait_seconds": 120,\n'
            '  "webhook_url": "http://127.0.0.1:9999/hooks/youtube"\n'
            "}"
        )
        self._body_text = QTextEdit()
        self._body_text.setReadOnly(True)
        self._body_text.setMaximumHeight(160)
        self._body_text.setPlainText(body)
        sample_lay.addWidget(self._body_text)

        note = QLabel(
            "Auth is off by default. Projects appear under the same “This device” account as the desktop. "
            "Set INTEGRATION_AUTH_REQUIRED=true in .env only if you expose the API beyond localhost."
        )
        note.setProperty("class", "muted")
        note.setWordWrap(True)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 16, 16, 16)
        lay.setSpacing(12)
        lay.addWidget(hero)
        lay.addWidget(sub)
        lay.addWidget(start_box)
        lay.addWidget(webhook_box)
        lay.addWidget(ref_box)
        lay.addWidget(sample_box)
        lay.addWidget(note)
        lay.addStretch()
        self._load_webhook_field()

    def _load_webhook_field(self) -> None:
        env = (os.environ.get("AGENT_WEBHOOK_URL") or settings.agent_webhook_url or "").strip()
        disk = load_saved_agent_webhook_url() or ""
        self._webhook_edit.setText(env or disk)

    def _save_webhook(self) -> None:
        url = self._webhook_edit.text().strip()
        save_agent_webhook_url(url)
        if url:
            os.environ["AGENT_WEBHOOK_URL"] = url
        else:
            os.environ.pop("AGENT_WEBHOOK_URL", None)
        QMessageBox.information(
            self,
            "Webhook",
            "Saved to backend/data/desktop_ui.json. Restart uvicorn if it was already running.",
        )

    def _clear_webhook(self) -> None:
        clear_saved_agent_webhook_url()
        os.environ.pop("AGENT_WEBHOOK_URL", None)
        self._webhook_edit.clear()
        QMessageBox.information(self, "Webhook", "Cleared saved webhook URL.")

    def _copy_sample_curl(self) -> None:
        base = "http://127.0.0.1:8000"
        prefix = settings.api_prefix.rstrip("/")
        curl = (
            f'curl -X POST "{base}{prefix}/agent/v1/runs" ^\n'
            f'  -H "Content-Type: application/json" ^\n'
            f'  -d "{{\\"title\\":\\"Hermes run\\",\\"theme\\":\\"History mysteries\\",'
            f'\\"episode_topic\\":\\"Lost temple\\",\\"pipeline_mode\\":\\"script_only\\",'
            f'\\"wait_seconds\\":120}}"'
        )
        QGuiApplication.clipboard().setText(curl)
        QMessageBox.information(self, "Copied", "Sample curl copied to clipboard (Windows escaping).")
