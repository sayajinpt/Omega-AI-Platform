from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from PyQt6.QtCore import QObject, QRunnable, Qt, QThreadPool, QTimer, pyqtSignal
from PyQt6.QtGui import QAction, QCloseEvent, QFont, QTextCursor
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QFileDialog,
    QDialog,
    QDockWidget,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QInputDialog,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.enums import JobStatus
from app.config import settings
from app.database import SessionLocal
from app.desktop.api_panel import LocalApiPanel
from app.desktop.dialogs import LoginDialog, NewProjectDialog, RegisterDialog
from app.desktop.theme import mark_danger, mark_primary
from app.desktop.desktop_models_settings import (
    clear_saved_tavily_key,
    load_saved_tavily_key,
    save_tavily_key,
)
from app.desktop.local_profile import get_or_create_local_user, is_local_profile_user
from app.desktop.models_panel import ModelsManagementWidget
from app.desktop.project_page import ProjectPageDialog
from app.models import Job, JobLog, User, VideoProject
from app.services import platform_admin
from app.services.episode_factory import clone_video_project
from app.services.pipeline_jobs import enqueue_pipeline_job
from app.services.schedule_tick import run_schedule_tick
from app.workers.queue import shutdown_job_executor


class _Signals(QObject):
    ok = pyqtSignal(str)
    err = pyqtSignal(str)


class _Runnable(QRunnable):
    def __init__(self, fn, signals: _Signals) -> None:
        super().__init__()
        self._fn = fn
        self._sig = signals

    def run(self) -> None:
        try:
            msg = self._fn()
            self._sig.ok.emit(msg or "Done.")
        except Exception as exc:  # noqa: BLE001
            self._sig.err.emit(str(exc))


class MainWindow(QMainWindow):
    """Main workspace; sign-in is optional until features need it (e.g. YouTube upload)."""

    # Marshals GPU/pipeline log lines from worker threads to the GUI thread (Qt is not thread-safe).
    _gpu_console_msg = pyqtSignal(str)

    def __init__(self, user: User, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._user = user
        self.resize(1120, 720)
        self._pool = QThreadPool.globalInstance()

        tabs = QTabWidget()
        tabs.addTab(self._build_projects_tab(), "Projects")
        tabs.addTab(self._build_models_tab(), "Models")
        tabs.addTab(self._build_system_tab(), "System")
        tabs.addTab(LocalApiPanel(), "Local API")

        central = QWidget()
        QVBoxLayout(central).addWidget(tabs)
        self.setCentralWidget(central)
        self._apply_window_title()
        self._build_event_console_dock()
        self._gpu_console_msg.connect(self._append_event_console, Qt.ConnectionType.QueuedConnection)
        self._build_menu_bar()

        self.statusBar().showMessage("Ready", 3000)
        self._sched_timer = QTimer(self)
        self._sched_timer.timeout.connect(self._tick_schedules)
        self._sched_timer.start(45_000)

        self._watch_job_id: str | None = None
        self._job_poll_timer = QTimer(self)
        self._job_poll_timer.setInterval(450)
        self._job_poll_timer.timeout.connect(self._poll_generation_job)

        try:
            from localgen.gpu_runtime import set_event_sink

            # Worker threads must not touch widgets directly — route through queued signal.
            set_event_sink(lambda msg: self._gpu_console_msg.emit(msg))
        except ImportError:
            pass
        self._append_event_console("Application started.")
        self._suppress_project_table = False

    def _tick_schedules(self) -> None:
        db = SessionLocal()
        try:
            summary = run_schedule_tick(db, user_id=self._user.id)
        except Exception as exc:  # noqa: BLE001
            self.statusBar().showMessage(f"Schedule check failed: {exc}", 8000)
            return
        finally:
            db.close()
        if summary.get("enqueued_count"):
            titles = ", ".join(x["title"] for x in summary["enqueued"][:3])
            extra = "…" if summary["enqueued_count"] > 3 else ""
            self.statusBar().showMessage(
                f"Scheduled generation queued ({summary['enqueued_count']}): {titles}{extra}",
                12000,
            )
            self._reload_projects()
            self._append_event_console(
                f"[schedule] queued {summary['enqueued_count']} generation(s): {titles}{extra}"
            )

    def _apply_window_title(self) -> None:
        if is_local_profile_user(self._user):
            self.setWindowTitle("YouTube Automation — this device (not signed in)")
        else:
            self.setWindowTitle(f"YouTube Automation — {self._user.email}")

    def _build_event_console_dock(self) -> None:
        self._event_console = QPlainTextEdit()
        self._event_console.setReadOnly(True)
        self._event_console.setMaximumBlockCount(12_000)
        self._event_console.setPlaceholderText("Timestamps: pipeline, schedules, model downloads, GPU unload…")
        self._event_console.setFont(QFont("Consolas", 10))

        dock = QDockWidget("Event console", self)
        dock.setObjectName("EventConsoleDock")
        dock.setAllowedAreas(
            Qt.DockWidgetArea.BottomDockWidgetArea | Qt.DockWidgetArea.TopDockWidgetArea
        )
        dock.setWidget(self._event_console)
        self.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, dock)
        self._dock_event_console = dock

        self._act_view_console = QAction("Event console", self)
        self._act_view_console.setCheckable(True)
        self._act_view_console.setChecked(True)
        self._act_view_console.toggled.connect(dock.setVisible)
        dock.visibilityChanged.connect(self._act_view_console.setChecked)

    def _append_event_console(self, msg: str) -> None:
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        self._event_console.appendPlainText(line)
        sb = self._event_console.verticalScrollBar()
        sb.setValue(sb.maximum())

    def _build_models_tab(self) -> QWidget:
        return ModelsManagementWidget(self._append_event_console, self)

    def _build_menu_bar(self) -> None:
        mb = self.menuBar()
        ac = mb.addMenu("Account")
        ac.addAction("Sign in with email…", self._account_sign_in)
        ac.addAction("Register new account…", self._account_register)
        self._act_sign_out = ac.addAction("Sign out (local workspace only)", self._account_sign_out)
        self._act_sign_out.setEnabled(not is_local_profile_user(self._user))
        ac.addSeparator()
        ac.addAction("When do I need to sign in?…", self._account_help)

        vm = mb.addMenu("View")
        vm.addAction(self._act_view_console)

    def _account_help(self) -> None:
        QMessageBox.information(
            self,
            "Sign-in",
            "You can use projects, generation, and system tools immediately — no login required.\n\n"
            "Use Account → Sign in when the app needs your identity, for example to post videos "
            "to YouTube (when that step is wired up). The optional REST API still uses JWT from "
            "POST /api/auth/login for scripts.",
        )

    def _account_sign_in(self) -> None:
        dlg = LoginDialog(self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        u = dlg.authenticated_user()
        if u is None:
            return
        self._user = u
        self._apply_window_title()
        self._act_sign_out.setEnabled(True)
        self._reload_projects()

    def _account_register(self) -> None:
        dlg = RegisterDialog(self)
        if dlg.exec() != QDialog.DialogCode.Accepted or not dlg.created_user:
            return
        self._user = dlg.created_user
        self._apply_window_title()
        self._act_sign_out.setEnabled(True)
        self._reload_projects()

    def _account_sign_out(self) -> None:
        self._user = get_or_create_local_user()
        self._apply_window_title()
        self._act_sign_out.setEnabled(False)
        self._reload_projects()

    def _build_projects_tab(self) -> QWidget:
        w = QWidget()
        self._proj_table = QTableWidget(0, 7)
        self._proj_table.setHorizontalHeaderLabels(
            ["On", "Title", "Series", "Type", "Max s", "Status", "Theme (preview)"]
        )
        self._proj_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self._proj_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self._proj_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self._proj_table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        self._proj_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._proj_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._proj_table.itemChanged.connect(self._on_project_table_item_changed)
        self._proj_table.itemDoubleClicked.connect(self._on_project_table_double_clicked)

        header = QLabel("Projects")
        header.setProperty("class", "hero")
        hint = QLabel("Double-click a row to edit. Generation runs on this machine.")
        hint.setProperty("class", "muted")

        btn_new = QPushButton("New project…")
        btn_new.clicked.connect(self._new_project)
        mark_primary(btn_new)
        btn_clone = QPushButton("Clone project…")
        btn_clone.setToolTip("Copy the selected project's settings into a new draft project.")
        btn_clone.clicked.connect(self._clone_project)
        btn_open = QPushButton("Open project…")
        btn_open.clicked.connect(self._open_selected_project_page)
        self._btn_gen = QPushButton("Generate")
        self._btn_gen.setToolTip("Runs the full script pipeline locally without upload. Does not remove scheduled runs.")
        self._btn_gen.clicked.connect(self._enqueue_generate_local)
        mark_primary(self._btn_gen)
        btn_del = QPushButton("Delete")
        btn_del.clicked.connect(self._delete_project)
        mark_danger(btn_del)
        btn_ref = QPushButton("Refresh")
        btn_ref.clicked.connect(self._reload_projects)

        row = QHBoxLayout()
        row.setSpacing(8)
        for b in (btn_new, btn_clone, btn_open, self._btn_gen, btn_del, btn_ref):
            row.addWidget(b)
        row.addStretch()

        lay = QVBoxLayout(w)
        lay.setContentsMargins(12, 12, 12, 12)
        lay.setSpacing(10)
        lay.addWidget(header)
        lay.addWidget(hint)
        lay.addLayout(row)
        lay.addWidget(self._proj_table)

        gen = QGroupBox("Generation progress")
        glay = QVBoxLayout(gen)
        self._gen_status_label = QLabel(
            "No job running. Select a video project row and click Generate — status and log lines update here."
        )
        self._gen_status_label.setWordWrap(True)
        self._gen_progress = QProgressBar()
        self._gen_progress.setRange(0, 1)
        self._gen_progress.setValue(0)
        self._gen_progress.setFormat("Idle")
        self._gen_log = QTextEdit()
        self._gen_log.setReadOnly(True)
        self._gen_log.setMaximumHeight(160)
        self._gen_log.setPlaceholderText("Job log output appears here while the pipeline runs.")
        glay.addWidget(self._gen_status_label)
        glay.addWidget(self._gen_progress)
        glay.addWidget(self._gen_log)
        lay.addWidget(gen)

        self._reload_projects()
        return w

    def _table_row_project_id(self, row: int) -> str | None:
        if row < 0:
            return None
        it_title = self._proj_table.item(row, 1)
        if not it_title:
            return None
        raw = it_title.data(Qt.ItemDataRole.UserRole)
        return raw if isinstance(raw, str) else None

    def _selected_project_id(self) -> str | None:
        return self._table_row_project_id(self._proj_table.currentRow())

    def _on_project_table_double_clicked(self, item: QTableWidgetItem) -> None:
        pid = self._table_row_project_id(item.row())
        if pid:
            self._open_project_page(pid)

    def _open_selected_project_page(self) -> None:
        pid = self._selected_project_id()
        if not pid:
            QMessageBox.information(self, "Select a row", "Choose a project row first.")
            return
        self._open_project_page(pid)

    def _open_project_page(self, project_id: str) -> None:
        dlg = ProjectPageDialog(self, self._user.id, project_id)
        dlg.exec()
        self._reload_projects()

    def _on_project_table_item_changed(self, item: QTableWidgetItem) -> None:
        if self._suppress_project_table or item.column() != 0:
            return
        row = item.row()
        oid = self._table_row_project_id(row)
        if not oid:
            return
        active = item.checkState() == Qt.CheckState.Checked
        db = SessionLocal()
        try:
            p = db.get(VideoProject, oid)
            if not p or p.user_id != self._user.id:
                return
            p.is_active = active
            db.add(p)
            db.commit()
        finally:
            db.close()
        self.statusBar().showMessage("Scheduling “On” checkbox saved.", 3000)

    def _reload_projects(self) -> None:
        uid = self._user.id
        db = SessionLocal()
        try:
            videos = (
                db.execute(
                    select(VideoProject)
                    .where(VideoProject.user_id == uid)
                    .options(selectinload(VideoProject.series))
                    .order_by(VideoProject.updated_at.desc())
                )
                .scalars()
                .all()
            )
        finally:
            db.close()

        self._suppress_project_table = True
        self._proj_table.setRowCount(0)
        for entity in videos:
            r = self._proj_table.rowCount()
            self._proj_table.insertRow(r)
            oid = entity.id

            chk = QTableWidgetItem("")
            chk.setFlags(chk.flags() | Qt.ItemFlag.ItemIsUserCheckable)

            chk.setCheckState(Qt.CheckState.Checked if entity.is_active else Qt.CheckState.Unchecked)
            title_txt = entity.title
            series_label = entity.series.title if entity.series else "—"
            vtype_txt = entity.video_type.value
            max_s = str(entity.max_duration_seconds)
            status_txt = entity.status.value
            theme_txt = (entity.theme or "")[:120] + ("…" if len(entity.theme or "") > 120 else "")

            self._proj_table.setItem(r, 0, chk)
            title_it = QTableWidgetItem(title_txt)
            title_it.setData(Qt.ItemDataRole.UserRole, oid)
            self._proj_table.setItem(r, 1, title_it)
            self._proj_table.setItem(r, 2, QTableWidgetItem(series_label))
            self._proj_table.setItem(r, 3, QTableWidgetItem(vtype_txt))
            self._proj_table.setItem(r, 4, QTableWidgetItem(max_s))
            self._proj_table.setItem(r, 5, QTableWidgetItem(status_txt))
            self._proj_table.setItem(r, 6, QTableWidgetItem(theme_txt))

        self._suppress_project_table = False

    def _new_project(self) -> None:
        dlg = NewProjectDialog(self, self._user.id)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        if dlg.projects:
            first = dlg.projects[0]
            if dlg.created_series_title and len(dlg.projects) > 1:
                QMessageBox.information(
                    self,
                    "Created",
                    f"Series “{dlg.created_series_title}” saved with {len(dlg.projects)} episode rows "
                    f"(first: “{first.title}”). Select a row to edit or generate.",
                )
            elif dlg.created_series_title:
                QMessageBox.information(
                    self,
                    "Created",
                    f"Series “{dlg.created_series_title}” saved.\n"
                    f"First episode “{first.title}” is in the project table — edit or generate from there.",
                )
            else:
                QMessageBox.information(self, "Created", f"Project “{first.title}” saved.")
        else:
            return
        self._reload_projects()

    def _clone_project(self) -> None:
        oid = self._selected_project_id()
        if not oid:
            QMessageBox.information(self, "Select a row", "Choose a project to clone first.")
            return
        db = SessionLocal()
        try:
            source = db.get(VideoProject, oid)
            if not source or source.user_id != self._user.id:
                QMessageBox.warning(self, "Not found", "Project not found.")
                return
            default_title = f"Copy of {source.title}"
        finally:
            db.close()

        title, ok = QInputDialog.getText(
            self,
            "Clone project",
            "Title for the new project:",
            text=default_title,
        )
        if not ok:
            return
        title = title.strip()
        if not title:
            QMessageBox.warning(self, "Title required", "Enter a title for the cloned project.")
            return

        db = SessionLocal()
        try:
            source = db.get(VideoProject, oid)
            if not source or source.user_id != self._user.id:
                return
            clone = clone_video_project(db, source=source, user_id=self._user.id, title=title)
            db.commit()
            db.refresh(clone)
            new_id = clone.id
            new_title = clone.title
        finally:
            db.close()

        self._reload_projects()
        self._select_project_row(new_id)
        QMessageBox.information(
            self,
            "Cloned",
            f"Created “{new_title}” with the same generation settings as the selected project.",
        )

    def _select_project_row(self, project_id: str) -> None:
        for r in range(self._proj_table.rowCount()):
            it = self._proj_table.item(r, 1)
            if it and it.data(Qt.ItemDataRole.UserRole) == project_id:
                self._proj_table.selectRow(r)
                break

    def _delete_project(self) -> None:
        oid = self._selected_project_id()
        if not oid:
            QMessageBox.information(self, "Select a row", "Choose a row in the table first.")
            return
        db = SessionLocal()
        try:
            if (
                QMessageBox.question(self, "Delete project", "Delete this project and all related data?")
                != QMessageBox.StandardButton.Yes
            ):
                return
            p = db.get(VideoProject, oid)
            if not p or p.user_id != self._user.id:
                return
            db.delete(p)
            db.commit()
        finally:
            db.close()
        self._reload_projects()

    def _enqueue_generate_local(self) -> None:
        pid = self._selected_project_id()
        if not pid:
            QMessageBox.information(self, "Select a project", "Choose a project row first.")
            return
        if self._watch_job_id and self._job_poll_timer.isActive():
            QMessageBox.information(
                self,
                "Busy",
                "A generation job is still in progress. Wait for it to finish, or watch the log below.",
            )
            return
        job = None
        title = ""
        db = SessionLocal()
        try:
            p = db.get(VideoProject, pid)
            if not p or p.user_id != self._user.id:
                return
            title = p.title
            job = enqueue_pipeline_job(db, p, post_publish=False, source="desktop_manual_local")
        finally:
            db.close()
        if job is None:
            return
        self._start_job_watcher(job.id, title)
        short = job.id[:8] if len(job.id) >= 8 else job.id
        self._append_event_console(f"[pipeline] Generate (local review) queued — “{title}” (job {short}…)")
        self.statusBar().showMessage("Generate queued — watch progress below.", 6000)

    def _start_job_watcher(self, job_id: str, project_title: str) -> None:
        if self._job_poll_timer.isActive():
            self._job_poll_timer.stop()
        self._watch_job_id = job_id
        mode = "Generate (local review)"
        short_id = job_id[:8] if len(job_id) >= 8 else job_id
        self._gen_status_label.setText(f"{mode} — “{project_title}” (job {short_id}…)")
        self._gen_progress.setRange(0, 0)
        self._gen_progress.setFormat("Working…")
        self._gen_log.clear()
        self._btn_gen.setEnabled(False)
        self._job_poll_timer.start()

    def _poll_generation_job(self) -> None:
        jid = self._watch_job_id
        if not jid:
            self._job_poll_timer.stop()
            return
        db = SessionLocal()
        try:
            job = db.get(Job, jid)
            if not job:
                self._finish_generation_watch(ok=False, message="Job record not found.")
                return
            logs = (
                db.execute(select(JobLog).where(JobLog.job_id == jid).order_by(JobLog.created_at.asc()))
                .scalars()
                .all()
            )
            text = "\n".join(f"[{x.level}] {x.message}" for x in logs)
            self._gen_log.setPlainText(text)
            cur = self._gen_log.textCursor()
            cur.movePosition(QTextCursor.MoveOperation.End)
            self._gen_log.setTextCursor(cur)

            if job.status == JobStatus.queued:
                self._gen_progress.setRange(0, 0)
                self._gen_progress.setFormat("Queued…")
            elif job.status == JobStatus.running:
                self._gen_progress.setRange(0, 0)
                self._gen_progress.setFormat("Running…")

            if job.status == JobStatus.succeeded:
                self._finish_generation_watch(ok=True, message="Finished successfully.")
            elif job.status == JobStatus.failed:
                self._finish_generation_watch(ok=False, message="Job failed — see log above.")
        finally:
            db.close()

    def _finish_generation_watch(self, *, ok: bool, message: str) -> None:
        self._job_poll_timer.stop()
        self._watch_job_id = None
        self._btn_gen.setEnabled(True)
        self._gen_progress.setRange(0, 100)
        self._gen_progress.setValue(100 if ok else 0)
        self._gen_progress.setFormat("Done" if ok else "Failed")
        self._gen_status_label.setText(f"Last job: {message}")
        self._reload_projects()
        self.statusBar().showMessage(message, 8000)
        self._append_event_console(f"[pipeline] {message}")
        if not ok:
            QMessageBox.warning(self, "Generation failed", "The pipeline reported failure. Check the log above.")

    def _build_system_tab(self) -> QWidget:
        w = QWidget()
        self._sys_log = QTextEdit()
        self._sys_log.setReadOnly(True)
        self._sys_log.setMinimumHeight(200)

        info = QLabel()
        info.setWordWrap(True)
        info.setTextFormat(Qt.TextFormat.RichText)
        self._sys_info_label = info

        tavily_grp = QGroupBox("Tavily web search — optional script research (same as TAVILY_API_KEY in backend/.env)")
        tv_lay = QVBoxLayout(tavily_grp)
        self._tavily_status = QLabel()
        self._tavily_status.setWordWrap(True)
        tv_row = QHBoxLayout()
        tv_row.addWidget(QLabel("API key:"))
        self._tavily_key_edit = QLineEdit()
        self._tavily_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        self._tavily_key_edit.setPlaceholderText("tvly-… paste here — Save stores in backend/data/desktop_ui.json")
        btn_tv_save = QPushButton("Save key")
        btn_tv_save.clicked.connect(self._save_tavily_key_ui)
        btn_tv_clear = QPushButton("Remove saved")
        btn_tv_clear.clicked.connect(self._clear_tavily_key_ui)
        tv_row.addWidget(self._tavily_key_edit)
        tv_row.addWidget(btn_tv_save)
        tv_row.addWidget(btn_tv_clear)
        tv_lay.addWidget(self._tavily_status)
        tv_lay.addLayout(tv_row)

        btn_migrate = QPushButton("Apply migrations (upgrade head)")
        btn_migrate.clicked.connect(self._run_migrate)
        btn_vac = QPushButton("SQLite VACUUM")
        btn_vac.clicked.connect(self._run_vacuum)
        btn_storage = QPushButton("Create storage folder")
        btn_storage.clicked.connect(self._mkdir_storage)
        btn_export = QPushButton("Export SQLite file…")
        btn_export.clicked.connect(self._export_sqlite)
        btn_refresh = QPushButton("Refresh status")
        btn_refresh.clicked.connect(self._refresh_system_info)

        danger = QGroupBox("Danger — reset SQLite (all data)")
        dlay = QVBoxLayout(danger)
        self._reset_confirm = QLineEdit()
        self._reset_confirm.setPlaceholderText("Type RESET ALL DATA to confirm")
        btn_reset = QPushButton("Erase database and restart app login")
        mark_danger(btn_reset)
        btn_reset.clicked.connect(self._reset_sqlite)
        dlay.addWidget(QLabel("Deletes the SQLite file and rebuilds empty tables. You will need to register again."))
        dlay.addWidget(self._reset_confirm)
        dlay.addWidget(btn_reset)

        row = QHBoxLayout()
        for b in (btn_migrate, btn_vac, btn_storage, btn_export, btn_refresh):
            row.addWidget(b)

        lay = QVBoxLayout(w)
        lay.addWidget(info)
        lay.addWidget(tavily_grp)
        lay.addLayout(row)
        lay.addWidget(self._sys_log)
        lay.addWidget(danger)
        self._refresh_system_info()
        return w

    def _log_sys(self, msg: str) -> None:
        self._sys_log.append(msg)

    def _refresh_system_info(self) -> None:
        db = SessionLocal()
        try:
            meta = platform_admin.database_display_info()
            rev = platform_admin.get_alembic_revision(db)
            counts_err = None
            try:
                counts = platform_admin.get_table_counts(db)
                ctext = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
            except Exception as exc:  # noqa: BLE001
                ctext = f"(counts unavailable: {exc})"
                counts_err = str(exc)
            storage = Path(settings.storage_path).expanduser().resolve()
            gen_override = (os.environ.get("GENERATION_MODELS_DATA_DIR") or "").strip()
            if gen_override:
                gen = Path(gen_override).expanduser().resolve()
                gen_note = " (from desktop / env GENERATION_MODELS_DATA_DIR)"
            else:
                gen = Path(settings.generation_models_data_dir).expanduser().resolve()
                gen_note = " (from app settings; override with Models tab or env)"
            lines = [
                f"<b>Database</b>: {meta['backend']} — <code>{meta['url_masked']}</code>",
            ]
            if meta.get("is_sqlite"):
                lines.append(
                    f"SQLite file: <code>{meta.get('sqlite_path', '')}</code> "
                    f"({'exists' if meta.get('sqlite_exists') else 'missing'})"
                )
            lines.append(f"<b>Alembic</b>: {rev or '—'}")
            lines.append(f"<b>Rows</b>: {ctext}")
            if counts_err:
                lines.append(f"<span style='color:#f87171'>{counts_err}</span>")
            lines.append(f"<b>Storage</b>: <code>{storage}</code> ({'ok' if storage.is_dir() else 'missing'})")
            lines.append(f"<b>Models dir</b>: <code>{gen}</code>{gen_note}")
            tv_env = (os.environ.get("TAVILY_API_KEY") or "").strip()
            tv_cfg = (settings.tavily_api_key or "").strip()
            if tv_env or tv_cfg:
                lines.append("<b>Tavily</b>: configured (see System tab for details)")
            else:
                lines.append("<b>Tavily</b>: <span style='color:#fbbf24'>not set — web research skipped</span>")
            self._sys_info_label.setText("<br/>".join(lines))
        finally:
            db.close()
        self._refresh_tavily_status()

    def _refresh_tavily_status(self) -> None:
        if not getattr(self, "_tavily_status", None):
            return
        env_tv = (os.environ.get("TAVILY_API_KEY") or "").strip()
        cfg_tv = (settings.tavily_api_key or "").strip()
        disk = load_saved_tavily_key()
        parts: list[str] = []
        if env_tv:
            parts.append(
                "Active for this session (environment). Saving below writes backend/data/desktop_ui.json — same effect after restart."
            )
        elif cfg_tv:
            parts.append(
                "Active from backend/.env or environment loaded at startup (pydantic settings). Desktop Save is optional."
            )
        elif disk:
            parts.append(
                "Key saved on disk — applied automatically next launch; paste again and Save to use immediately without restart."
            )
        else:
            parts.append(
                "No key: paste your Tavily key below (Save) or add TAVILY_API_KEY=… to backend/.env."
            )
        self._tavily_status.setText("\n".join(parts))

    def _save_tavily_key_ui(self) -> None:
        raw = self._tavily_key_edit.text().strip()
        if not raw:
            QMessageBox.information(self, "Tavily", "Paste your API key first, then Save.")
            return
        save_tavily_key(raw)
        os.environ["TAVILY_API_KEY"] = raw
        self._tavily_key_edit.clear()
        self._refresh_system_info()
        QMessageBox.information(
            self,
            "Tavily",
            "Saved to backend/data/desktop_ui.json (not logged). This session will use it immediately for script research.",
        )

    def _clear_tavily_key_ui(self) -> None:
        clear_saved_tavily_key()
        os.environ.pop("TAVILY_API_KEY", None)
        self._refresh_system_info()
        QMessageBox.information(
            self,
            "Tavily",
            "Removed saved key from desktop_ui.json and cleared TAVILY_API_KEY from this session. "
            "If the key still exists in backend/.env, restart the app or delete that line.",
        )

    def _run_async(self, fn, ok_title: str = "OK") -> None:
        sig = _Signals()
        sig.ok.connect(lambda m: (self._log_sys(m), QMessageBox.information(self, ok_title, m), self._refresh_system_info()))
        sig.err.connect(lambda m: (self._log_sys("ERROR: " + m), QMessageBox.critical(self, "Error", m)))
        self._pool.start(_Runnable(fn, sig))

    def _run_migrate_wrapped(self) -> str:
        platform_admin.run_migrations()
        return "Migrations applied successfully."

    def _run_migrate(self) -> None:
        self._run_async(self._run_migrate_wrapped)

    def _vacuum_wrapped(self) -> str:
        platform_admin.sqlite_vacuum()
        return "SQLite VACUUM finished."

    def _run_vacuum(self) -> None:
        self._run_async(self._vacuum_wrapped)

    def _mkdir_storage(self) -> None:
        Path(settings.storage_path).expanduser().mkdir(parents=True, exist_ok=True)
        QMessageBox.information(self, "Storage", f"Folder ready:\n{Path(settings.storage_path).expanduser().resolve()}")
        self._refresh_system_info()

    def _export_sqlite(self) -> None:
        info = platform_admin.database_display_info()
        if not info.get("is_sqlite"):
            QMessageBox.warning(self, "Export", "Export is only available for SQLite.")
            return
        p = Path(info["sqlite_path"])
        if not p.is_file():
            QMessageBox.warning(self, "Export", "Database file not found.")
            return
        dest, _ = QFileDialog.getSaveFileName(self, "Save database copy", str(p.name), "SQLite (*.db)")
        if not dest:
            return
        import shutil

        shutil.copy2(p, dest)
        QMessageBox.information(self, "Export", f"Copied to:\n{dest}")

    def _reset_sqlite(self) -> None:
        if self._reset_confirm.text().strip() != "RESET ALL DATA":
            QMessageBox.warning(self, "Confirmation", 'Type exactly: RESET ALL DATA')
            return
        if (
            QMessageBox.question(
                self,
                "Confirm erase",
                "This permanently deletes ALL users and projects. Continue?",
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        try:
            shutdown_job_executor(wait=True)
            platform_admin.reset_sqlite_database()
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Reset failed", str(exc))
            return
        QMessageBox.information(self, "Reset complete", "Database was recreated. Restart the application, then register again.")
        QApplication.instance().quit()

    def closeEvent(self, event: QCloseEvent) -> None:
        try:
            from localgen.gpu_runtime import unload_all

            unload_all(reason="app_close")
        except ImportError:
            pass
        super().closeEvent(event)
