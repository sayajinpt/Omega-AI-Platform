"""Full-screen project editor: settings, series + episodes, retention."""

from __future__ import annotations

from datetime import date, datetime, timezone

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDateEdit,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import SessionLocal
from app.desktop.generation_model_widgets import (
    populate_hf_repo_combo,
    populate_image_style_combo,
    select_hf_repo_combo,
    select_image_style_combo,
)
from app.desktop.dialogs import VIDEO_TYPE_CHOICES
from app.desktop.voice_widgets import (
    add_voice_form_rows,
    select_combo_by_data,
    select_tone_preset_for_text,
)
from app.services.narration_tone_presets import voice_style_for_persist
from app.models import Schedule, Series, VideoProject
from app.models.enums import VideoType
from app.services.project_retention import prune_series_episodes_keep_newest, prune_user_projects_keep_newest


class ProjectPageDialog(QDialog):
    """Manage one VideoProject, optional parent Series, sibling episodes, and retention."""

    def __init__(self, parent: QWidget | None, user_id: str, project_id: str) -> None:
        super().__init__(parent)
        self._user_id = user_id
        self._project_id = project_id
        self.setWindowTitle("Project")
        self.resize(760, 780)

        root = QVBoxLayout(self)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        inner = QWidget()
        self._body_layout = QVBoxLayout(inner)

        self._project_box = QGroupBox("Project")
        pf = QFormLayout(self._project_box)
        self._title = QLineEdit()
        self._theme = QTextEdit()
        self._theme.setMinimumHeight(72)
        self._notes = QTextEdit()
        self._notes.setMaximumHeight(64)
        self._episode_topic = QLineEdit()
        self._duration = QSpinBox()
        self._duration.setRange(1, 7 * 24 * 3600)
        self._vtype = QComboBox()
        for label, vt in VIDEO_TYPE_CHOICES:
            self._vtype.addItem(label, vt)
        self._subs = QCheckBox("Include subtitle/caption phrases")
        self._ai_title = QCheckBox("AI proposes YouTube title")
        self._web_research = QCheckBox("Search the web before script (Tavily)")
        self._web_research.setChecked(True)
        self._web_research.setToolTip("Uncheck to generate the script from the model’s knowledge only.")
        self._no_image = QCheckBox("No-image mode (audio + on-screen subtitles only — skip image generation)")
        self._no_image.setToolTip(
            "Renders flat subtitle cards instead of SD3 images. Faster, no GPU needed for visuals."
        )
        self._proj_active = QCheckBox("Project enabled for scheduled runs")
        self._sched_max = QSpinBox()
        self._sched_max.setRange(0, 999999)
        self._sched_max.setSpecialValueText("No limit")
        self._sched_max.setMinimum(0)
        self._sched_max.setValue(0)
        self._until_chk = QCheckBox("Schedule stops after (local date)")
        self._until_date = QDateEdit()
        self._until_date.setCalendarPopup(True)

        pf.addRow("Title", self._title)
        pf.addRow("Theme / brief", self._theme)
        pf.addRow("Extra notes", self._notes)
        pf.addRow("Episode angle (optional)", self._episode_topic)
        self._pv_topic_dedup = QSpinBox()
        self._pv_topic_dedup.setRange(1, 500)
        self._pv_topic_dedup.setValue(int(settings.project_topic_dedup_recent_count))
        self._pv_topic_dedup.setToolTip(
            "Standalone videos: how many other projects the script AI reads to avoid repeating topics. "
            "Series episodes use the series dedup setting instead."
        )
        pf.addRow("Prior projects for dedup", self._pv_topic_dedup)
        pf.addRow("Max duration (s)", self._duration)
        pf.addRow("Video format", self._vtype)
        pf.addRow(self._subs)
        pf.addRow(self._ai_title)
        pf.addRow(self._web_research)
        pf.addRow(self._no_image)
        pf.addRow(self._proj_active)
        pf.addRow("Max scheduled generations (0 = unlimited)", self._sched_max)
        lay_until = QHBoxLayout()
        lay_until.addWidget(self._until_chk)
        lay_until.addWidget(self._until_date)
        pf.addRow(lay_until)

        self._pv_gender = QComboBox()
        self._pv_lang = QComboBox()
        self._pv_speaker = QComboBox()
        self._pv_tone = QLineEdit()
        self._pv_tone_preset = QComboBox()
        self._refill_pv_voice, self._pv_voice_binder = add_voice_form_rows(
            pf,
            gender_combo=self._pv_gender,
            lang_combo=self._pv_lang,
            speaker_combo=self._pv_speaker,
            tone_edit=self._pv_tone,
            tone_preset_combo=self._pv_tone_preset,
        )
        self._pv_hf_tts = QComboBox()
        self._pv_hf_image = QComboBox()
        self._pv_image_style = QComboBox()
        populate_hf_repo_combo(self._pv_hf_tts, "tts")
        populate_hf_repo_combo(self._pv_hf_image, "image")
        populate_image_style_combo(self._pv_image_style)
        self._pv_image_style.setToolTip(
            "Art-style preset prepended to every scene prompt (e.g. Studio Ghibli, Anime, "
            "Photorealistic, Cyberpunk). Pick Auto to let the scene prompt steer the look."
        )
        pf.addRow("Local TTS model (HF repo)", self._pv_hf_tts)
        pf.addRow("Scene image model (HF repo)", self._pv_hf_image)
        pf.addRow("Image art style", self._pv_image_style)

        self._series_box = QGroupBox("Series (shared settings)")
        sf = QFormLayout(self._series_box)
        self._series_title = QLineEdit()
        self._series_theme = QTextEdit()
        self._series_theme.setMinimumHeight(56)
        self._series_notes = QTextEdit()
        self._series_notes.setMaximumHeight(48)
        self._episode_pat = QLineEdit()
        self._topic_dedup = QSpinBox()
        self._topic_dedup.setRange(1, 500)
        self._pending_topics = QTextEdit()
        self._pending_topics.setPlaceholderText("One topic per line, consumed when new episodes are scheduled.")
        self._pending_topics.setMaximumHeight(80)
        self._series_active = QCheckBox("Series enabled for schedules")
        self._series_web_def = QCheckBox("Default: web research for new episodes (Tavily)")
        self._series_web_def.setChecked(True)
        self._series_no_image_def = QCheckBox("Default: no-image mode for new episodes")
        sf.addRow("Series name", self._series_title)
        sf.addRow("Series theme / bible", self._series_theme)
        sf.addRow("Series notes", self._series_notes)
        sf.addRow("Episode title pattern", self._episode_pat)
        sf.addRow("Prior episodes for dedup", self._topic_dedup)
        sf.addRow("Queued episode topics", self._pending_topics)
        self._sv_gender = QComboBox()
        self._sv_lang = QComboBox()
        self._sv_speaker = QComboBox()
        self._sv_tone = QLineEdit()
        self._sv_tone_preset = QComboBox()
        self._refill_sv_voice, self._sv_voice_binder = add_voice_form_rows(
            sf,
            gender_combo=self._sv_gender,
            lang_combo=self._sv_lang,
            speaker_combo=self._sv_speaker,
            tone_edit=self._sv_tone,
            label_prefix="Default ",
            tone_preset_combo=self._sv_tone_preset,
        )
        self._sv_hf_tts = QComboBox()
        self._sv_hf_image = QComboBox()
        self._sv_image_style = QComboBox()
        populate_hf_repo_combo(self._sv_hf_tts, "tts")
        populate_hf_repo_combo(self._sv_hf_image, "image")
        populate_image_style_combo(self._sv_image_style)
        self._sv_image_style.setToolTip(
            "Default art-style preset every new episode inherits. Pick Auto to let scene prompts decide."
        )
        sf.addRow("Default local TTS model (HF repo)", self._sv_hf_tts)
        sf.addRow("Default scene image model (HF repo)", self._sv_hf_image)
        sf.addRow("Default image art style", self._sv_image_style)
        sf.addRow(self._series_web_def)
        sf.addRow(self._series_no_image_def)
        sf.addRow(self._series_active)

        self._ep_box = QGroupBox("Episodes in this series")
        elay = QVBoxLayout(self._ep_box)
        self._ep_table = QTableWidget(0, 4)
        self._ep_table.setHorizontalHeaderLabels(["Title", "Status", "Updated", ""])
        self._ep_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self._ep_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._ep_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        btn_ep_open = QPushButton("Open selected episode…")
        btn_ep_open.clicked.connect(self._open_selected_episode)
        elay.addWidget(self._ep_table)
        elay.addWidget(btn_ep_open)

        self._sched_label = QLabel("")
        self._sched_label.setWordWrap(True)
        self._sched_label.setStyleSheet("color:#94a3b8")

        ret = QGroupBox("Disk space — prune old rows")
        rlay = QVBoxLayout(ret)
        rlay.addWidget(
            QLabel(
                "Removes old project/episode rows from the database. Media files on disk under storage/ "
                "are not deleted automatically — remove those manually if needed."
            )
        )
        row_a = QHBoxLayout()
        self._keep_account = QSpinBox()
        self._keep_account.setRange(1, 50_000)
        self._keep_account.setValue(50)
        btn_prune_acc = QPushButton("Delete oldest projects (account-wide)")
        btn_prune_acc.clicked.connect(self._run_prune_account)
        row_a.addWidget(QLabel("Keep newest N projects"))
        row_a.addWidget(self._keep_account)
        row_a.addWidget(btn_prune_acc)
        row_a.addStretch()
        rlay.addLayout(row_a)

        row_b = QHBoxLayout()
        self._keep_series_eps = QSpinBox()
        self._keep_series_eps.setRange(1, 50_000)
        self._keep_series_eps.setValue(30)
        self._btn_prune_series = QPushButton("Delete oldest episodes in this series")
        self._btn_prune_series.clicked.connect(self._run_prune_series)
        row_b.addWidget(QLabel("Keep newest N episodes in series"))
        row_b.addWidget(self._keep_series_eps)
        row_b.addWidget(self._btn_prune_series)
        row_b.addStretch()
        rlay.addLayout(row_b)

        self._body_layout.addWidget(self._project_box)
        self._body_layout.addWidget(self._series_box)
        self._body_layout.addWidget(self._ep_box)
        self._body_layout.addWidget(self._sched_label)
        self._body_layout.addWidget(ret)

        scroll.setWidget(inner)
        root.addWidget(scroll)

        bbox = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Close)
        bbox.button(QDialogButtonBox.StandardButton.Save).clicked.connect(self._save_all)
        bbox.button(QDialogButtonBox.StandardButton.Close).clicked.connect(self.reject)
        root.addWidget(bbox)

        self._series_box.setVisible(False)
        self._ep_box.setVisible(False)
        self._btn_prune_series.setEnabled(False)

        self._load()

    def _load(self) -> None:
        db = SessionLocal()
        try:
            p = db.get(VideoProject, self._project_id)
            if not p or p.user_id != self._user_id:
                QMessageBox.warning(self, "Missing", "Project not found.")
                self.reject()
                return
            p = db.execute(
                select(VideoProject).where(VideoProject.id == p.id).options(selectinload(VideoProject.series))
            ).scalar_one()

            self._title.setText(p.title)
            self._theme.setPlainText(p.theme)
            self._notes.setPlainText(p.content_notes or "")
            self._episode_topic.setText(p.episode_topic or "")
            self._duration.setValue(p.max_duration_seconds)
            for i in range(self._vtype.count()):
                if self._vtype.itemData(i) == p.video_type:
                    self._vtype.setCurrentIndex(i)
                    break
            self._subs.setChecked(p.include_subtitles)
            self._ai_title.setChecked(p.use_ai_video_title)
            self._web_research.setChecked(getattr(p, "script_use_web_research", True))
            self._no_image.setChecked(bool(getattr(p, "no_image_mode", False)))
            self._proj_active.setChecked(p.is_active)
            if p.schedule_max_runs is None:
                self._sched_max.setValue(0)
            else:
                self._sched_max.setValue(p.schedule_max_runs)
            if p.schedule_runs_until_utc:
                ru = p.schedule_runs_until_utc
                if ru.tzinfo is None:
                    ru = ru.replace(tzinfo=timezone.utc)
                local = ru.astimezone()
                self._until_chk.setChecked(True)
                self._until_date.setDate(date(local.year, local.month, local.day))
            else:
                self._until_chk.setChecked(False)
                self._until_date.setDate(date.today())

            select_combo_by_data(self._pv_lang, getattr(p, "tts_language", None) or "English")
            select_combo_by_data(self._pv_gender, getattr(p, "voice_gender", None) or "any")
            self._refill_pv_voice()
            select_combo_by_data(self._pv_speaker, getattr(p, "tts_speaker", None) or "Ryan")
            raw_vs = getattr(p, "tts_voice_style", None)
            if self._pv_voice_binder is not None:
                self._pv_voice_binder.apply_style_dict(raw_vs)
                if raw_vs is not None:
                    self._pv_voice_binder.recompose()
                else:
                    self._pv_tone.setText(getattr(p, "narration_tone", None) or "")
                    select_tone_preset_for_text(self._pv_tone_preset, self._pv_tone.text())
            else:
                self._pv_tone.setText(getattr(p, "narration_tone", None) or "")
                select_tone_preset_for_text(self._pv_tone_preset, self._pv_tone.text())
            select_hf_repo_combo(self._pv_hf_tts, getattr(p, "hf_tts_repo_id", None), kind="tts")
            select_hf_repo_combo(self._pv_hf_image, getattr(p, "hf_image_repo_id", None), kind="image")
            select_image_style_combo(self._pv_image_style, getattr(p, "image_style", None))
            dedup_n = getattr(p, "topic_dedup_recent_count", None)
            self._pv_topic_dedup.setValue(int(dedup_n or settings.project_topic_dedup_recent_count))
            self._pv_topic_dedup.setEnabled(not bool(p.series_id))

            sched_lines: list[str] = []
            for s in db.execute(select(Schedule).where(Schedule.project_id == p.id)).scalars():
                sched_lines.append(f"• project schedule: {s.cron_expression} ({s.timezone}) active={s.is_active}")

            if p.series_id:
                ser = p.series or db.get(Series, p.series_id)
                if ser:
                    self._series_box.setVisible(True)
                    self._ep_box.setVisible(True)
                    self._btn_prune_series.setEnabled(True)
                    self._series_title.setText(ser.title)
                    self._series_theme.setPlainText(ser.theme)
                    self._series_notes.setPlainText(ser.series_notes or "")
                    self._episode_pat.setText(ser.episode_title_pattern)
                    self._topic_dedup.setValue(ser.topic_dedup_recent_count)
                    topics = ser.pending_episode_topics or []
                    self._pending_topics.setPlainText("\n".join(topics))
                    self._series_active.setChecked(ser.is_active)
                    select_combo_by_data(self._sv_lang, ser.default_tts_language or "English")
                    select_combo_by_data(self._sv_gender, ser.default_voice_gender or "any")
                    self._refill_sv_voice()
                    select_combo_by_data(self._sv_speaker, ser.default_tts_speaker or "Ryan")
                    raw_svs = getattr(ser, "default_tts_voice_style", None)
                    if self._sv_voice_binder is not None:
                        self._sv_voice_binder.apply_style_dict(raw_svs)
                        if raw_svs is not None:
                            self._sv_voice_binder.recompose()
                        else:
                            self._sv_tone.setText(ser.default_narration_tone or "")
                            select_tone_preset_for_text(self._sv_tone_preset, self._sv_tone.text())
                    else:
                        self._sv_tone.setText(ser.default_narration_tone or "")
                        select_tone_preset_for_text(self._sv_tone_preset, self._sv_tone.text())
                    select_hf_repo_combo(self._sv_hf_tts, getattr(ser, "default_hf_tts_repo_id", None), kind="tts")
                    select_hf_repo_combo(self._sv_hf_image, getattr(ser, "default_hf_image_repo_id", None), kind="image")
                    select_image_style_combo(self._sv_image_style, getattr(ser, "default_image_style", None))
                    self._series_web_def.setChecked(getattr(ser, "default_script_use_web_research", True))
                    self._series_no_image_def.setChecked(bool(getattr(ser, "default_no_image_mode", False)))

                    eps = (
                        db.execute(
                            select(VideoProject)
                            .where(VideoProject.series_id == ser.id)
                            .order_by(VideoProject.created_at.desc())
                        )
                        .scalars()
                        .all()
                    )
                    self._ep_table.setRowCount(len(eps))
                    for r, ep in enumerate(eps):
                        tit = QTableWidgetItem(ep.title)
                        tit.setData(Qt.ItemDataRole.UserRole, ep.id)
                        self._ep_table.setItem(r, 0, tit)
                        self._ep_table.setItem(r, 1, QTableWidgetItem(ep.status.value))
                        self._ep_table.setItem(
                            r,
                            2,
                            QTableWidgetItem(ep.updated_at.strftime("%Y-%m-%d %H:%M") if ep.updated_at else ""),
                        )
                        open_btn = QPushButton("Open")
                        open_btn.clicked.connect(lambda checked=False, pid=ep.id: self._open_episode(pid))
                        self._ep_table.setCellWidget(r, 3, open_btn)

                    for s in db.execute(select(Schedule).where(Schedule.series_id == ser.id)).scalars():
                        sched_lines.append(f"• series schedule: {s.cron_expression} ({s.timezone}) active={s.is_active}")

            self._sched_label.setText("Schedules:\n" + ("\n".join(sched_lines) if sched_lines else "— none —"))
        finally:
            db.close()

    def _save_all(self) -> None:
        vt = self._vtype.currentData()
        assert isinstance(vt, VideoType)

        db = SessionLocal()
        try:
            p = db.get(VideoProject, self._project_id)
            if not p or p.user_id != self._user_id:
                return
            p.title = self._title.text().strip()
            p.theme = self._theme.toPlainText().strip()
            p.content_notes = self._notes.toPlainText().strip() or None
            p.episode_topic = self._episode_topic.text().strip() or None
            p.max_duration_seconds = int(self._duration.value())
            p.video_type = vt
            p.include_subtitles = self._subs.isChecked()
            p.use_ai_video_title = self._ai_title.isChecked()
            p.script_use_web_research = self._web_research.isChecked()
            p.no_image_mode = self._no_image.isChecked()
            p.is_active = self._proj_active.isChecked()
            sm = int(self._sched_max.value())
            p.schedule_max_runs = None if sm <= 0 else sm
            if self._until_chk.isChecked():
                d = self._until_date.date().toPyDate()
                p.schedule_runs_until_utc = datetime(d.year, d.month, d.day, 23, 59, 59, tzinfo=timezone.utc)
            else:
                p.schedule_runs_until_utc = None
            p.tts_speaker = str(self._pv_speaker.currentData() or "Ryan")
            p.tts_language = str(self._pv_lang.currentData() or "English")
            p.narration_tone = self._pv_tone.text().strip() or None
            if self._pv_voice_binder is not None:
                p.tts_voice_style = voice_style_for_persist(self._pv_voice_binder.style_dict())
            p.voice_gender = str(self._pv_gender.currentData() or "any")
            p.hf_tts_repo_id = self._pv_hf_tts.currentData()
            p.hf_image_repo_id = self._pv_hf_image.currentData()
            p.image_style = (str(self._pv_image_style.currentData() or "").strip().lower() or None)
            if not p.series_id:
                p.topic_dedup_recent_count = int(self._pv_topic_dedup.value())
            db.add(p)

            if p.series_id:
                ser = db.get(Series, p.series_id)
                if ser and ser.user_id == self._user_id:
                    ser.title = self._series_title.text().strip()
                    ser.theme = self._series_theme.toPlainText().strip()
                    ser.series_notes = self._series_notes.toPlainText().strip() or None
                    ser.episode_title_pattern = self._episode_pat.text().strip() or "{series} — Episode {n}"
                    ser.topic_dedup_recent_count = int(self._topic_dedup.value())
                    lines = [ln.strip() for ln in self._pending_topics.toPlainText().splitlines() if ln.strip()]
                    ser.pending_episode_topics = lines if lines else None
                    ser.is_active = self._series_active.isChecked()
                    ser.default_tts_speaker = str(self._sv_speaker.currentData() or "Ryan")
                    ser.default_tts_language = str(self._sv_lang.currentData() or "English")
                    ser.default_narration_tone = self._sv_tone.text().strip() or None
                    if self._sv_voice_binder is not None:
                        ser.default_tts_voice_style = voice_style_for_persist(self._sv_voice_binder.style_dict())
                    ser.default_voice_gender = str(self._sv_gender.currentData() or "any")
                    ser.default_hf_tts_repo_id = self._sv_hf_tts.currentData()
                    ser.default_hf_image_repo_id = self._sv_hf_image.currentData()
                    ser.default_image_style = (
                        str(self._sv_image_style.currentData() or "").strip().lower() or None
                    )
                    ser.default_script_use_web_research = self._series_web_def.isChecked()
                    ser.default_no_image_mode = self._series_no_image_def.isChecked()
                    db.add(ser)

            db.commit()
            QMessageBox.information(self, "Saved", "Project settings saved.")
        finally:
            db.close()

    def _open_selected_episode(self) -> None:
        r = self._ep_table.currentRow()
        if r < 0:
            return
        it = self._ep_table.item(r, 0)
        if not it:
            return
        pid = it.data(Qt.ItemDataRole.UserRole)
        if isinstance(pid, str):
            self._open_episode(pid)

    def _open_episode(self, project_id: str) -> None:
        child = ProjectPageDialog(self.parent(), self._user_id, project_id)
        child.exec()
        self._load()

    def _run_prune_account(self) -> None:
        n = int(self._keep_account.value())
        if (
            QMessageBox.question(
                self,
                "Confirm",
                f"Keep the {n} most recently updated projects and permanently delete all older project rows?",
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        db = SessionLocal()
        try:
            deleted, _ = prune_user_projects_keep_newest(db, user_id=self._user_id, keep_count=n)
        finally:
            db.close()
        QMessageBox.information(self, "Done", f"Deleted {deleted} older project(s).")
        still = SessionLocal()
        try:
            gone = still.get(VideoProject, self._project_id) is None
        finally:
            still.close()
        if gone:
            QMessageBox.information(self, "Closed", "This project was removed by cleanup.")
            self.reject()
            return
        self._load()

    def _run_prune_series(self) -> None:
        db = SessionLocal()
        try:
            p = db.get(VideoProject, self._project_id)
            if not p or not p.series_id:
                return
            sid = p.series_id
        finally:
            db.close()
        n = int(self._keep_series_eps.value())
        if (
            QMessageBox.question(
                self,
                "Confirm",
                f"Keep the {n} newest episodes in this series and delete older episode projects?",
            )
            != QMessageBox.StandardButton.Yes
        ):
            return
        db = SessionLocal()
        try:
            deleted, _ = prune_series_episodes_keep_newest(db, series_id=sid, user_id=self._user_id, keep_count=n)
        finally:
            db.close()
        QMessageBox.information(self, "Done", f"Deleted {deleted} older episode(s).")
        still = SessionLocal()
        try:
            gone = still.get(VideoProject, self._project_id) is None
        finally:
            still.close()
        if gone:
            QMessageBox.information(self, "Closed", "This episode was removed by cleanup.")
            self.reject()
            return
        self._load()
