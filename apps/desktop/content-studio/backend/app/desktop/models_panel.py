"""Models storage, Hugging Face downloads, and GPU unload controls for the desktop app."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from PyQt6.QtCore import QObject, Qt, QRunnable, QThreadPool, QTimer, pyqtSignal
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from app.desktop.desktop_models_settings import (
    clear_saved_hf_token,
    load_saved_hf_token,
    save_hf_token,
    save_models_data_dir,
)

try:
    from localgen.downloads import download_snapshot
    from localgen.gpu_runtime import status_line, unload_all
    from localgen.hf_urls import parse_hf_repo_id
    from localgen.installed_models import register_installed_model
    from localgen.paths import get_models_root
    from localgen.registry import IMAGE_MODEL_CATALOG, TTS_MODEL_CATALOG
except ImportError:
    download_snapshot = None  # type: ignore[assignment]
    unload_all = None  # type: ignore[assignment]
    status_line = None  # type: ignore[assignment]
    get_models_root = None  # type: ignore[assignment]
    parse_hf_repo_id = None  # type: ignore[assignment]
    register_installed_model = None  # type: ignore[assignment]
    TTS_MODEL_CATALOG = {}
    IMAGE_MODEL_CATALOG = {}


def _reveal_path(path: Path) -> None:
    path = path.resolve()
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.run(["open", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path)], check=False)


def _dir_nonempty(p: Path) -> bool:
    if not p.is_dir():
        return False
    try:
        next(p.iterdir())
    except StopIteration:
        return False
    return True


class _DownloadSignals(QObject):
    line = pyqtSignal(str)
    ok = pyqtSignal(str, str)
    err = pyqtSignal(str)


class _DownloadRunnable(QRunnable):
    def __init__(self, repo_id: str, dest: Path, kind_slug: str, sig: _DownloadSignals) -> None:
        super().__init__()
        self._repo = repo_id
        self._dest = dest
        self._kind_slug = kind_slug
        self._sig = sig

    def run(self) -> None:
        if download_snapshot is None:
            self._sig.err.emit("localgen is not installed (generation_models package missing).")
            return
        try:
            self._sig.line.emit(f"Download started: {self._repo} → {self._dest}")
            download_snapshot(self._repo, self._dest)
            self._sig.ok.emit(self._repo, self._kind_slug)
        except Exception as exc:  # noqa: BLE001
            self._sig.err.emit(str(exc))


class ModelsManagementWidget(QWidget):
    """Single root directory for all catalog snapshots; download rows; free VRAM."""

    def __init__(self, event_sink: Callable[[str], None], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._event_sink = event_sink
        self._pool = QThreadPool.globalInstance()
        self._dl_signals = _DownloadSignals()
        self._dl_signals.line.connect(self._on_download_line)
        self._dl_signals.ok.connect(self._on_download_ok)
        self._dl_signals.err.connect(self._on_download_err)
        self._download_busy = False

        root = get_models_root() if get_models_root else Path.home() / "youtube_generation_models"
        top = QGroupBox("Model storage (Hugging Face snapshots)")
        tlay = QVBoxLayout(top)
        row = QHBoxLayout()
        row.addWidget(QLabel("Root folder:"))
        self._root_edit = QLineEdit(str(root))
        btn_browse = QPushButton("Browse…")
        btn_browse.clicked.connect(self._browse_root)
        btn_apply = QPushButton("Save & use")
        btn_apply.setToolTip("Writes backend/data/desktop_ui.json and sets GENERATION_MODELS_DATA_DIR for this session.")
        btn_apply.clicked.connect(self._save_root)
        btn_open = QPushButton("Open folder")
        btn_open.clicked.connect(self._open_root)
        row.addWidget(self._root_edit)
        row.addWidget(btn_browse)
        row.addWidget(btn_apply)
        row.addWidget(btn_open)
        tlay.addLayout(row)

        hf_grp = QGroupBox("Hugging Face account (recommended for download speed)")
        hf_lay = QVBoxLayout(hf_grp)
        hf_row = QHBoxLayout()
        hf_row.addWidget(QLabel("API token:"))
        self._hf_token_edit = QLineEdit()
        self._hf_token_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self._hf_token_edit.setPlaceholderText(" hf_… paste here, Save — token is never logged")
        btn_hf_save = QPushButton("Save token")
        btn_hf_save.clicked.connect(self._save_hf_token)
        btn_hf_clear = QPushButton("Clear saved")
        btn_hf_clear.clicked.connect(self._clear_hf_token)
        hf_row.addWidget(self._hf_token_edit)
        hf_row.addWidget(btn_hf_save)
        hf_row.addWidget(btn_hf_clear)
        hf_lay.addLayout(hf_row)
        self._hf_saved_label = QLabel()
        hf_help = QLabel(
            "Environment variables <code>HF_TOKEN</code> or <code>HUGGING_FACE_HUB_TOKEN</code> override the saved "
            "token. Create or revoke tokens at "
            '<a href="https://huggingface.co/settings/tokens">huggingface.co/settings/tokens</a>. '
            "<code>backend/data/desktop_ui.json</code> is gitignored but still plain text on disk — use env vars if you prefer."
        )
        hf_help.setWordWrap(True)
        hf_help.setOpenExternalLinks(True)
        hf_help.setTextFormat(Qt.TextFormat.RichText)
        hf_lay.addWidget(self._hf_saved_label)
        hf_lay.addWidget(hf_help)
        tlay.addWidget(hf_grp)

        url_grp = QGroupBox("Download from Hugging Face model page")
        url_lay = QVBoxLayout(url_grp)
        url_row = QHBoxLayout()
        url_row.addWidget(QLabel("Weights folder:"))
        self._url_kind = QComboBox()
        self._url_kind.addItem("TTS (Qwen-tts)", "tts")
        self._url_kind.addItem("Image / SD3 weights", "image")
        self._url_input = QLineEdit()
        self._url_input.setPlaceholderText("https://huggingface.co/org/model or org/model")
        self._btn_url_dl = QPushButton("Download")
        self._btn_url_dl.clicked.connect(self._download_from_url)
        url_row.addWidget(self._url_kind)
        url_row.addWidget(self._url_input, stretch=1)
        url_row.addWidget(self._btn_url_dl)
        url_lay.addLayout(url_row)
        url_hint = QLabel(
            "Paste a model card URL or <code>organization/model-name</code>. "
            "Files are saved under <code>&lt;root&gt;/tts/</code> or <code>&lt;root&gt;/image/</code> "
            "so projects can pin this repo."
        )
        url_hint.setWordWrap(True)
        url_hint.setTextFormat(Qt.TextFormat.RichText)
        url_lay.addWidget(url_hint)
        tlay.addWidget(url_grp)

        gpu = QGroupBox("GPU — one heavy model at a time")
        glay = QVBoxLayout(gpu)
        self._gpu_help = QLabel(
            "TTS and SD3 share VRAM: the pipeline unloads after each TTS run; after SD3, click unload or dispose "
            "the pipeline in code. Use the button below if something still holds memory."
        )
        self._gpu_help.setWordWrap(True)
        glay.addWidget(self._gpu_help)
        self._gpu_status = QLabel("")
        btn_unload = QPushButton("Free GPU memory now")
        btn_unload.clicked.connect(self._unload_gpu)
        glay.addWidget(self._gpu_status)
        glay.addWidget(btn_unload)

        self._table = QTableWidget(0, 6)
        self._table.setHorizontalHeaderLabels(["Kind", "Name", "Repo ID", "Size", "Relative path", "On disk"])
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)

        dl_row = QHBoxLayout()
        self._btn_dl = QPushButton("Download selected")
        self._btn_dl.clicked.connect(self._download_selected)
        dl_row.addWidget(self._btn_dl)
        dl_row.addStretch()

        lay = QVBoxLayout(self)
        lay.addWidget(top)
        lay.addWidget(gpu)
        lay.addWidget(QLabel(
            'Catalog (extras: from repo root run pip install -e "./generation_models[tts,image]"):'
        ))
        lay.addWidget(self._table)
        lay.addLayout(dl_row)

        self._refresh_hf_saved_label()
        self._refresh_table()
        self._tick_gpu_status()
        self._gpu_timer = QTimer(self)
        self._gpu_timer.timeout.connect(self._tick_gpu_status)
        self._gpu_timer.start(2000)

    def _emit(self, msg: str) -> None:
        self._event_sink(msg)

    def _refresh_hf_saved_label(self) -> None:
        has_file = load_saved_hf_token() is not None
        env = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
        if env:
            self._hf_saved_label.setText("Active token: from environment variable (preferred).")
        elif has_file:
            self._hf_saved_label.setText("Active token: loaded from desktop_ui.json at app start.")
        else:
            self._hf_saved_label.setText(
                "No token in env or saved file — downloads work anonymously; signup + token avoids stricter limits."
            )

    def _save_hf_token(self) -> None:
        raw = self._hf_token_edit.text().strip()
        if not raw:
            QMessageBox.information(self, "HF token", "Paste your token first, then Save.")
            return
        save_hf_token(raw)
        os.environ["HF_TOKEN"] = raw
        self._hf_token_edit.clear()
        self._emit("[models] Hugging Face token saved to desktop_ui.json (value not logged).")
        self._refresh_hf_saved_label()
        QMessageBox.information(
            self,
            "HF token",
            "Saved. Downloads in this session will use it. If you previously set HF_TOKEN in the environment, "
            "that still takes priority until you unset it.",
        )

    def _clear_hf_token(self) -> None:
        clear_saved_hf_token()
        self._refresh_hf_saved_label()
        self._emit("[models] Hugging Face token removed from desktop_ui.json.")
        QMessageBox.information(
            self,
            "HF token",
            "Removed from saved settings. Restart the app to stop using an in-memory token from the old saved value, "
            "or unset HF_TOKEN / HUGGING_FACE_HUB_TOKEN in your shell if you use those.",
        )

    def _browse_root(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "Models root", self._root_edit.text())
        if d:
            self._root_edit.setText(d)

    def _save_root(self) -> None:
        path = Path(self._root_edit.text().strip()).expanduser()
        try:
            path.mkdir(parents=True, exist_ok=True)
            path = path.resolve()
        except OSError as exc:
            QMessageBox.warning(self, "Invalid path", str(exc))
            return
        self._root_edit.setText(str(path))
        save_models_data_dir(str(path))
        os.environ["GENERATION_MODELS_DATA_DIR"] = str(path)
        self._emit(f"[models] storage root set to {path}")
        self._refresh_table()
        QMessageBox.information(
            self,
            "Saved",
            "Storage path saved for this app session and written to desktop_ui.json.\n"
            "Restart the app if another tool needs the same env var picked up at process start.",
        )

    def _open_root(self) -> None:
        p = Path(self._root_edit.text().strip()).expanduser()
        _reveal_path(p)

    def _unload_gpu(self) -> None:
        if unload_all is None:
            QMessageBox.warning(self, "localgen", "generation_models package not available.")
            return
        unload_all(reason="desktop_button")
        self._emit("[models] unload_all() requested")
        self._tick_gpu_status()

    def _tick_gpu_status(self) -> None:
        if status_line is None:
            self._gpu_status.setText("GPU status: localgen not installed.")
            return
        self._gpu_status.setText(status_line())

    def _refresh_table(self) -> None:
        rows: list[tuple[str, str, str, str, str]] = []

        for name, info in TTS_MODEL_CATALOG.items():
            rid = info["id"]
            safe = rid.replace("/", "__")
            rows.append(("TTS", name, rid, info.get("size", ""), f"tts/{safe}"))
        for name, info in IMAGE_MODEL_CATALOG.items():
            rid = info["id"]
            safe = rid.replace("/", "__")
            rows.append(("Image", name, rid, info.get("size", ""), f"image/{safe}"))

        self._table.setRowCount(len(rows))
        raw_root = self._root_edit.text().strip()
        if raw_root:
            root = Path(raw_root).expanduser().resolve()
        elif get_models_root is not None:
            root = get_models_root()
        else:
            root = Path.home() / "youtube_generation_models"

        for i, (kind, title, rid, size, rel) in enumerate(rows):
            kind_slug = "tts" if kind == "TTS" else "image"
            local = root / kind_slug / rid.replace("/", "__")
            ok = _dir_nonempty(local)
            self._table.setItem(i, 0, QTableWidgetItem(kind))
            self._table.setItem(i, 1, QTableWidgetItem(title))
            self._table.setItem(i, 2, QTableWidgetItem(rid))
            self._table.setItem(i, 3, QTableWidgetItem(size))
            self._table.setItem(i, 4, QTableWidgetItem(rel))
            self._table.setItem(i, 5, QTableWidgetItem("yes" if ok else "no"))
            self._table.item(i, 0).setData(Qt.ItemDataRole.UserRole, (kind_slug, rid))

    def _download_selected(self) -> None:
        if download_snapshot is None:
            QMessageBox.warning(
                self,
                "localgen",
                'Install generation_models from repo root:\npip install -e "./generation_models"\n'
                'Or from backend folder:\npip install -e "../generation_models"',
            )
            return
        if self._download_busy:
            QMessageBox.information(self, "Busy", "A download is already running.")
            return
        r = self._table.currentRow()
        if r < 0:
            QMessageBox.information(self, "Select a row", "Choose a catalog row first.")
            return
        it = self._table.item(r, 0)
        if not it:
            return
        data = it.data(Qt.ItemDataRole.UserRole)
        if not data:
            return
        kind_slug, repo_id = data
        root = Path(self._root_edit.text().strip()).expanduser().resolve()
        safe = repo_id.replace("/", "__")
        dest = root / kind_slug / safe
        if QMessageBox.question(
            self,
            "Download",
            f"Download snapshot?\n\n{repo_id}\n→\n{dest}\n\nThis may use several GB.",
        ) != QMessageBox.StandardButton.Yes:
            return
        dest.mkdir(parents=True, exist_ok=True)
        self._download_busy = True
        self._btn_dl.setEnabled(False)
        self._btn_url_dl.setEnabled(False)
        self._pool.start(_DownloadRunnable(repo_id, dest, kind_slug, self._dl_signals))

    def _download_from_url(self) -> None:
        if download_snapshot is None:
            QMessageBox.warning(
                self,
                "localgen",
                'Install generation_models from repo root:\npip install -e "./generation_models"\n'
                'Or from backend folder:\npip install -e "../generation_models"',
            )
            return
        if parse_hf_repo_id is None or register_installed_model is None:
            QMessageBox.warning(self, "localgen", "generation_models package incomplete.")
            return
        if self._download_busy:
            QMessageBox.information(self, "Busy", "A download is already running.")
            return
        raw = self._url_input.text().strip()
        repo_id = parse_hf_repo_id(raw)
        if not repo_id:
            QMessageBox.warning(
                self,
                "Invalid",
                "Could not parse a Hugging Face model id. Use org/model or a huggingface.co model URL.",
            )
            return
        kind_slug = str(self._url_kind.currentData() or "tts")
        root = Path(self._root_edit.text().strip()).expanduser().resolve()
        safe = repo_id.replace("/", "__")
        dest = root / kind_slug / safe
        if QMessageBox.question(
            self,
            "Download",
            f"Download snapshot?\n\n{repo_id}\n→\n{dest}\n\nThis may use several GB.",
        ) != QMessageBox.StandardButton.Yes:
            return
        dest.mkdir(parents=True, exist_ok=True)
        self._download_busy = True
        self._btn_dl.setEnabled(False)
        self._btn_url_dl.setEnabled(False)
        self._pool.start(_DownloadRunnable(repo_id, dest, kind_slug, self._dl_signals))

    def _on_download_line(self, msg: str) -> None:
        self._emit(msg)

    def _on_download_ok(self, repo_id: str, kind_slug: str) -> None:
        self._download_busy = False
        self._btn_dl.setEnabled(True)
        self._btn_url_dl.setEnabled(True)
        root = Path(self._root_edit.text().strip()).expanduser().resolve()
        if register_installed_model is not None:
            try:
                register_installed_model(root, repo_id, kind_slug)  # type: ignore[arg-type]
            except Exception as exc:  # noqa: BLE001
                self._emit(f"[models] manifest write skipped: {exc}")
        msg = f"Finished: {repo_id}"
        self._emit(msg)
        self._refresh_table()
        QMessageBox.information(self, "Download", msg)

    def _on_download_err(self, msg: str) -> None:
        self._download_busy = False
        self._btn_dl.setEnabled(True)
        self._btn_url_dl.setEnabled(True)
        self._emit(f"ERROR: {msg}")
        QMessageBox.critical(self, "Download failed", msg)
