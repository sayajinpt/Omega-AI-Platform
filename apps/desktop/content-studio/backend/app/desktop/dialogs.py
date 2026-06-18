from __future__ import annotations

from datetime import date, datetime, time, timezone

from PyQt6.QtCore import QDate
from PyQt6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDateEdit,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QRadioButton,
    QSpinBox,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from sqlalchemy import select

from app.core.security import hash_password, verify_password
from app.config import settings
from app.database import SessionLocal
from app.desktop.local_profile import LOCAL_PROFILE_EMAIL
from app.desktop.generation_model_widgets import (
    populate_hf_repo_combo,
    populate_image_style_combo,
    select_image_style_combo,
)
from app.desktop.voice_widgets import add_voice_form_rows
from app.services.episode_factory import bootstrap_series_episodes
from app.services.narration_tone_presets import voice_style_for_persist
from app.models import Schedule, Series, User, VideoProject
from app.models.enums import ProjectStatus, VideoType
from app.services.cron_helpers import weekly_crons_for, weekday_bitmask_to_crondows
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _safe_tz(name: str) -> ZoneInfo:
    try:
        return ZoneInfo((name or "UTC").strip() or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _end_of_local_day_utc(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time(23, 59, 59), tzinfo=tz).astimezone(timezone.utc)


class LoginDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Sign in — YouTube Automation")
        self._user: User | None = None
        self._email = QLineEdit()
        self._email.setPlaceholderText("email@example.com")
        self._pw = QLineEdit()
        self._pw.setEchoMode(QLineEdit.EchoMode.Password)
        self._pw.setPlaceholderText("Password")
        form = QFormLayout()
        form.addRow("Email", self._email)
        form.addRow("Password", self._pw)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self._try_login)
        buttons.rejected.connect(self.reject)
        reg = QDialogButtonBox()
        reg.addButton("Create account…", QDialogButtonBox.ButtonRole.ActionRole).clicked.connect(self._open_register)
        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(reg)
        lay.addWidget(buttons)

    def authenticated_user(self) -> User | None:
        return self._user

    def _try_login(self) -> None:
        db = SessionLocal()
        try:
            user = db.execute(select(User).where(User.email == self._email.text().strip())).scalar_one_or_none()
            if not user or not verify_password(self._pw.text(), user.hashed_password):
                QMessageBox.warning(self, "Login failed", "Invalid email or password.")
                return
            self._user = user
            self.accept()
        finally:
            db.close()

    def _open_register(self) -> None:
        reg = RegisterDialog(self)
        if reg.exec() == QDialog.DialogCode.Accepted and reg.created_user:
            self._user = reg.created_user
            self.accept()


class RegisterDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Create account")
        self.created_user: User | None = None
        self._name = QLineEdit()
        self._email = QLineEdit()
        self._pw = QLineEdit()
        self._pw.setEchoMode(QLineEdit.EchoMode.Password)
        self._pw.setPlaceholderText("At least 8 characters")
        form = QFormLayout()
        form.addRow("Name (optional)", self._name)
        form.addRow("Email", self._email)
        form.addRow("Password", self._pw)
        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        box.accepted.connect(self._submit)
        box.rejected.connect(self.reject)
        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(box)

    def _submit(self) -> None:
        email = self._email.text().strip()
        pw = self._pw.text()
        if email == LOCAL_PROFILE_EMAIL:
            QMessageBox.warning(self, "Reserved email", "That address is reserved for the built-in offline profile.")
            return
        if len(pw) < 8:
            QMessageBox.warning(self, "Invalid password", "Password must be at least 8 characters.")
            return
        db = SessionLocal()
        try:
            existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
            if existing:
                QMessageBox.warning(self, "Email taken", "That email is already registered.")
                return
            user = User(
                email=email,
                hashed_password=hash_password(pw),
                name=(self._name.text().strip() or None),
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            self.created_user = user
            self.accept()
        finally:
            db.close()


class NewProjectDialog(QDialog):
    """Single standalone video, or a series (first episode row created immediately; more on schedule)."""

    def __init__(self, parent: QWidget | None, user_id: str) -> None:
        super().__init__(parent)
        self._user_id = user_id
        self.project: VideoProject | None = None
        self.projects: list[VideoProject] = []
        self.created_series_title: str | None = None
        self.setWindowTitle("New project")
        self.resize(600, 860)

        self._mode_single = QRadioButton("Single video project")
        self._mode_series = QRadioButton("Series (first episode appears now; more on schedule)")
        self._mode_single.setChecked(True)
        grp = QButtonGroup(self)
        grp.addButton(self._mode_single)
        grp.addButton(self._mode_series)
        mode_row = QHBoxLayout()
        mode_row.addWidget(self._mode_single)
        mode_row.addWidget(self._mode_series)
        mode_row.addStretch()

        self._vtype = QComboBox()
        for label, vt in VIDEO_TYPE_CHOICES:
            self._vtype.addItem(label, vt)
        self._vtype.setCurrentIndex(0)

        self._duration = QSpinBox()
        self._duration.setRange(1, 7 * 24 * 3600)
        self._duration.setValue(600)

        shared = QFormLayout()
        shared.addRow("Video format", self._vtype)
        shared.addRow("Target duration (seconds)", self._duration)

        self._stack = QStackedWidget()
        self._stack.addWidget(self._build_single_page())
        self._stack.addWidget(self._build_series_page())

        self._mode_single.toggled.connect(lambda on: self._stack.setCurrentIndex(0 if on else 1))

        self._sched_group = self._build_shared_schedule_panel()

        hint = QLabel(
            "Schedules choose weekdays and one or more local clock times — each produces one cron trigger per clock time. "
            "Single-video Generate always runs locally for review (no upload). Scheduled runs use the publish pipeline flag "
            "(upload when wired). Series episodes are only created when a slot fires. "
            "Topic de-duplication lists prior sibling episodes so the AI avoids repeating recent angles."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#94a3b8;font-size:11px")

        box = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        box.accepted.connect(self._save)
        box.rejected.connect(self.reject)

        lay = QVBoxLayout(self)
        lay.addLayout(mode_row)
        lay.addLayout(shared)
        lay.addWidget(self._stack)
        lay.addWidget(self._sched_group)
        lay.addWidget(hint)
        lay.addWidget(box)

    def _build_shared_schedule_panel(self) -> QGroupBox:
        g = QGroupBox("Publishing schedule (saved to SQLite — optional)")
        gl = QVBoxLayout(g)

        self._sched_enable = QCheckBox(
            "Enable schedule for this project or series "
            "(uncheck only if you will add cron later via the API)."
        )

        dow_row = QHBoxLayout()
        self._dow_checks: list[QCheckBox] = []
        labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        for i, lbl in enumerate(labels):
            cb = QCheckBox(lbl)
            cb.setChecked(i < 5)
            self._dow_checks.append(cb)
            dow_row.addWidget(cb)
        dow_row.addStretch()

        self._times_edit = QTextEdit()
        self._times_edit.setMaximumHeight(80)
        self._times_edit.setPlaceholderText("Times in 24h, one HH:MM per line (e.g. 09:00 and 17:30 for two videos/day).")

        self._sched_tz = QLineEdit()
        self._sched_tz.setText("UTC")

        eff_row = QHBoxLayout()
        self._effective_from_chk = QCheckBox("Start scheduling after")
        self._effective_from_date = QDateEdit()
        self._effective_from_date.setCalendarPopup(True)
        self._effective_from_date.setDate(QDate.currentDate())
        eff_row.addWidget(self._effective_from_chk)
        eff_row.addWidget(self._effective_from_date)
        eff_row.addStretch()

        end_row = QHBoxLayout()
        self._rb_end_none = QRadioButton("Keep running indefinitely")
        self._rb_until = QRadioButton("Stop after date")
        self._rb_cap = QRadioButton("Maximum scheduled runs total")
        self._rb_end_none.setChecked(True)
        ego = QButtonGroup(self)
        for x in (self._rb_end_none, self._rb_until, self._rb_cap):
            ego.addButton(x)
        end_row.addWidget(self._rb_end_none)
        end_row.addWidget(self._rb_until)
        end_row.addWidget(self._rb_cap)

        tail = QHBoxLayout()
        self._until_date = QDateEdit()
        self._until_date.setCalendarPopup(True)
        self._until_date.setDate(QDate.currentDate())
        self._max_runs = QSpinBox()
        self._max_runs.setRange(1, 100_000)
        self._max_runs.setValue(24)
        tail.addWidget(QLabel("End date"))
        tail.addWidget(self._until_date)
        tail.addSpacing(12)
        tail.addWidget(QLabel("Max runs"))
        tail.addWidget(self._max_runs)
        tail.addStretch()

        gl.addWidget(self._sched_enable)
        gl.addWidget(QLabel("Days of week (local):"))
        gl.addLayout(dow_row)
        gl.addWidget(QLabel("Clock times"))
        gl.addWidget(self._times_edit)
        gl.addWidget(QLabel("Timezone (IANA, e.g. America/New_York)"))
        gl.addWidget(self._sched_tz)
        gl.addLayout(eff_row)
        gl.addLayout(end_row)
        gl.addLayout(tail)

        self._effective_from_chk.toggled.connect(self._effective_from_date.setEnabled)
        self._effective_from_date.setEnabled(False)
        self._until_date.setEnabled(False)
        self._max_runs.setEnabled(False)
        self._rb_until.toggled.connect(lambda on: self._until_date.setEnabled(on))
        self._rb_cap.toggled.connect(lambda on: self._max_runs.setEnabled(on))

        return g

    def _gather_schedule_bundle(self) -> tuple[list[str], str, datetime | None, datetime | None, int | None] | None:
        if not self._sched_enable.isChecked():
            return None
        tz_raw = self._sched_tz.text().strip() or "UTC"
        tz = _safe_tz(tz_raw)
        times = [
            ln.strip()
            for ln in self._times_edit.toPlainText().splitlines()
            if ln.strip()
        ]
        if not times:
            return None
        day_map = {i: cb.isChecked() for i, cb in enumerate(self._dow_checks)}
        dow = weekday_bitmask_to_crondows(day_map)
        if not dow:
            return None
        try:
            crons = weekly_crons_for(times, dow)
        except ValueError:
            QMessageBox.warning(self, "Schedule", "Each time must be HH:MM in 24h format.")
            return None

        eff: datetime | None = None
        if self._effective_from_chk.isChecked():
            dq = self._effective_from_date.date().toPyDate()
            eff = datetime.combine(dq, time.min, tzinfo=tz).astimezone(timezone.utc)

        ent_until: datetime | None = None
        ent_cap: int | None = None
        if self._rb_until.isChecked():
            dq = self._until_date.date().toPyDate()
            ent_until = _end_of_local_day_utc(dq, tz)
        elif self._rb_cap.isChecked():
            ent_cap = int(self._max_runs.value())

        return crons, tz_raw, eff, ent_until, ent_cap

    def _persist_schedules_entity(
        self,
        db,
        *,
        crons: list[str],
        timezone_str: str,
        effective_from_utc: datetime | None,
        project_id: str | None,
        series_id: str | None,
    ) -> None:
        for c in crons:
            db.add(
                Schedule(
                    project_id=project_id,
                    series_id=series_id,
                    cron_expression=c,
                    timezone=timezone_str,
                    is_active=True,
                    effective_from_utc=effective_from_utc,
                )
            )

    def _build_single_page(self) -> QWidget:
        w = QWidget()
        self._title = QLineEdit()
        self._theme = QTextEdit()
        self._theme.setMinimumHeight(100)
        self._notes = QTextEdit()
        self._notes.setMaximumHeight(70)
        self._subs = QCheckBox("Include on-screen subtitles / caption phrases in the script (text_overlays)")
        self._ai_title = QCheckBox("Let AI propose the final YouTube title and description")
        self._ai_title.setChecked(True)
        self._web_research = QCheckBox("Search the web for script sources (Tavily) before writing the script")
        self._web_research.setChecked(True)
        self._web_research.setToolTip(
            "Uncheck to use only the AI model’s knowledge — no live web lookup (still uses your theme and notes)."
        )
        self._no_image = QCheckBox("No-image mode (audio + on-screen subtitles only — skip image generation)")
        self._no_image.setToolTip(
            "Renders flat subtitle cards instead of SD3 images. Faster, no GPU needed for visuals; "
            "the narration text itself appears on screen."
        )
        form = QFormLayout(w)
        form.addRow("Title (or working title)", self._title)
        form.addRow("Theme / brief", self._theme)
        form.addRow("Extra notes (optional)", self._notes)
        form.addRow(self._subs)
        form.addRow(self._ai_title)
        form.addRow(self._web_research)
        form.addRow(self._no_image)
        self._single_topic_dedup = QSpinBox()
        self._single_topic_dedup.setRange(1, 500)
        self._single_topic_dedup.setValue(int(settings.project_topic_dedup_recent_count))
        self._single_topic_dedup.setToolTip(
            "Before script generation, the AI sees this many of your other projects (newest first) "
            "and must pick a different angle — same idea as series episode de-duplication."
        )
        form.addRow("Prior projects listed for dedup", self._single_topic_dedup)
        self._voice_gender = QComboBox()
        self._tts_language = QComboBox()
        self._tts_speaker = QComboBox()
        self._narration_tone = QLineEdit()
        self._narration_tone_preset = QComboBox()
        self._refill_voice_single, self._binder_voice_single = add_voice_form_rows(
            form,
            gender_combo=self._voice_gender,
            lang_combo=self._tts_language,
            speaker_combo=self._tts_speaker,
            tone_edit=self._narration_tone,
            tone_preset_combo=self._narration_tone_preset,
        )
        self._hf_tts = QComboBox()
        self._hf_image = QComboBox()
        self._image_style = QComboBox()
        populate_hf_repo_combo(self._hf_tts, "tts")
        populate_hf_repo_combo(self._hf_image, "image")
        populate_image_style_combo(self._image_style)
        self._image_style.setToolTip(
            "Art-style preset prepended to every scene prompt (e.g. Studio Ghibli, Anime, "
            "Photorealistic, Cyberpunk). Pick Auto to let the scene prompt steer the look."
        )
        form.addRow("Local TTS model (HF repo)", self._hf_tts)
        form.addRow("Scene image model (HF repo)", self._hf_image)
        form.addRow("Image art style", self._image_style)
        return w

    def _build_series_page(self) -> QWidget:
        w = QWidget()
        self._series_title = QLineEdit()
        self._series_theme = QTextEdit()
        self._series_theme.setMinimumHeight(90)
        self._series_notes = QTextEdit()
        self._series_notes.setMaximumHeight(60)
        self._topic_dedup = QSpinBox()
        self._topic_dedup.setRange(1, 500)
        self._topic_dedup.setValue(30)
        self._topic_dedup.setToolTip(
            "Each time an episode generates, the AI sees this many prior siblings (titles/topics) "
            "and avoids repeating angles."
        )
        self._title_pat = QLineEdit()
        self._title_pat.setPlaceholderText("{series} — Episode {n}")
        self._title_pat.setText("{series} — Episode {n}")
        self._episode_topics = QTextEdit()
        self._episode_topics.setPlaceholderText(
            "Optional queued topics — one line per episode, consumed first → last as episodes are created."
        )
        self._episode_topics.setMaximumHeight(120)
        self._series_subs = QCheckBox("Default: include subtitle/caption phrases for episodes")
        self._series_ai_title = QCheckBox("Let AI propose each episode title")
        self._series_ai_title.setChecked(True)
        self._series_web_research = QCheckBox("Default: search the web for each new episode’s script (Tavily)")
        self._series_web_research.setChecked(True)
        self._series_no_image = QCheckBox("Default: no-image mode for new episodes (audio + subtitles only)")
        form = QFormLayout(w)
        form.addRow("Series name", self._series_title)
        form.addRow("Series theme / bible", self._series_theme)
        form.addRow("Series-wide notes (optional)", self._series_notes)
        form.addRow("Prior episodes listed for dedup", self._topic_dedup)
        form.addRow("Episode title pattern", self._title_pat)
        form.addRow("Queued episode topics", self._episode_topics)
        form.addRow(self._series_subs)
        form.addRow(self._series_ai_title)
        form.addRow(self._series_web_research)
        form.addRow(self._series_no_image)
        self._s_voice_gender = QComboBox()
        self._s_tts_language = QComboBox()
        self._s_tts_speaker = QComboBox()
        self._s_narration_tone = QLineEdit()
        self._s_narration_tone_preset = QComboBox()
        self._refill_voice_series, self._binder_voice_series = add_voice_form_rows(
            form,
            gender_combo=self._s_voice_gender,
            lang_combo=self._s_tts_language,
            speaker_combo=self._s_tts_speaker,
            tone_edit=self._s_narration_tone,
            label_prefix="Default ",
            tone_preset_combo=self._s_narration_tone_preset,
        )
        self._s_hf_tts = QComboBox()
        self._s_hf_image = QComboBox()
        self._s_image_style = QComboBox()
        populate_hf_repo_combo(self._s_hf_tts, "tts")
        populate_hf_repo_combo(self._s_hf_image, "image")
        populate_image_style_combo(self._s_image_style)
        self._s_image_style.setToolTip(
            "Default art-style preset every new episode inherits (e.g. Studio Ghibli, Anime, "
            "Photorealistic). Pick Auto to let scene prompts decide."
        )
        form.addRow("Default local TTS model (HF repo)", self._s_hf_tts)
        form.addRow("Default scene image model (HF repo)", self._s_hf_image)
        form.addRow("Default image art style", self._s_image_style)
        return w

    def _current_video_type(self) -> VideoType:
        return self._vtype.currentData()

    def _save(self) -> None:
        dur = int(self._duration.value())

        plan = self._gather_schedule_bundle()
        if self._sched_enable.isChecked() and plan is None:
            QMessageBox.warning(
                self,
                "Schedule",
                "Pick at least one weekday, add one HH:MM per line under clock times.",
            )
            return

        if self._mode_single.isChecked():
            self.created_series_title = None
            self._save_single(vt, dur, plan)
        else:
            self._save_series(vt, dur, plan)

    def _save_single(
        self,
        vt: VideoType,
        dur: int,
        plan: tuple[list[str], str, datetime | None, datetime | None, int | None] | None,
    ) -> None:
        title = self._title.text().strip()
        theme = self._theme.toPlainText().strip()
        ai_title = self._ai_title.isChecked()
        if not theme:
            QMessageBox.warning(self, "Missing fields", "Theme / brief is required.")
            return
        if not title and not ai_title:
            QMessageBox.warning(self, "Title", "Enter a title, or enable “Let AI propose title”.")
            return
        if not title:
            title = "Untitled (AI)"

        db = SessionLocal()
        try:
            runs_until = plan[3] if plan else None
            max_runs = plan[4] if plan else None
            p = VideoProject(
                user_id=self._user_id,
                title=title,
                theme=theme,
                max_duration_seconds=dur,
                video_type=vt,
                content_notes=(self._notes.toPlainText().strip() or None),
                include_subtitles=self._subs.isChecked(),
                use_ai_video_title=ai_title,
                tts_speaker=str(self._tts_speaker.currentData() or "Ryan"),
                tts_language=str(self._tts_language.currentData() or "English"),
                narration_tone=(self._narration_tone.text().strip() or None),
                tts_voice_style=voice_style_for_persist(self._binder_voice_single.style_dict())
                if self._binder_voice_single
                else None,
                voice_gender=str(self._voice_gender.currentData() or "any"),
                hf_tts_repo_id=self._hf_tts.currentData(),
                hf_image_repo_id=self._hf_image.currentData(),
                image_style=self._image_style.currentData(),
                topic_dedup_recent_count=int(self._single_topic_dedup.value()),
                script_use_web_research=self._web_research.isChecked(),
                no_image_mode=self._no_image.isChecked(),
                status=ProjectStatus.draft,
                is_active=True,
                schedule_runs_until_utc=runs_until,
                schedule_max_runs=max_runs,
            )
            db.add(p)
            db.flush()

            if plan:
                crons, tz_raw, effective_from, ru, mr = plan
                assert p.id
                self._persist_schedules_entity(
                    db,
                    crons=crons,
                    timezone_str=tz_raw,
                    effective_from_utc=effective_from,
                    project_id=p.id,
                    series_id=None,
                )

            db.commit()
            db.refresh(p)
            self.project = p
            self.projects = [p]
            self.created_series_title = None
            self.accept()
        finally:
            db.close()

    def _save_series(
        self,
        vt: VideoType,
        dur: int,
        plan: tuple[list[str], str, datetime | None, datetime | None, int | None] | None,
    ) -> None:
        stitle = self._series_title.text().strip()
        stheme = self._series_theme.toPlainText().strip()
        if not stitle or not stheme:
            QMessageBox.warning(self, "Missing fields", "Series name and series theme are required.")
            return
        topics_raw = self._episode_topics.toPlainText().strip()
        topic_lines = [ln.strip() for ln in topics_raw.splitlines() if ln.strip()]
        pat = self._title_pat.text().strip() or "{series} — Episode {n}"

        db = SessionLocal()
        try:
            runs_until = plan[3] if plan else None
            max_runs = plan[4] if plan else None
            series = Series(
                user_id=self._user_id,
                title=stitle,
                theme=stheme,
                default_max_duration_seconds=dur,
                default_video_type=vt,
                default_include_subtitles=self._series_subs.isChecked(),
                default_tts_speaker=str(self._s_tts_speaker.currentData() or "Ryan"),
                default_tts_language=str(self._s_tts_language.currentData() or "English"),
                default_narration_tone=(self._s_narration_tone.text().strip() or None),
                default_tts_voice_style=voice_style_for_persist(self._binder_voice_series.style_dict())
                if self._binder_voice_series
                else None,
                default_voice_gender=str(self._s_voice_gender.currentData() or "any"),
                topic_dedup_recent_count=int(self._topic_dedup.value()),
                episode_title_pattern=pat,
                pending_episode_topics=topic_lines if topic_lines else None,
                is_active=True,
                series_notes=(self._series_notes.toPlainText().strip() or None),
                schedule_runs_until_utc=runs_until,
                schedule_max_runs=max_runs,
                schedule_completed_runs=0,
                next_episode_number=1,
                default_hf_tts_repo_id=self._s_hf_tts.currentData(),
                default_hf_image_repo_id=self._s_hf_image.currentData(),
                default_image_style=self._s_image_style.currentData(),
                default_script_use_web_research=self._series_web_research.isChecked(),
                default_no_image_mode=self._series_no_image.isChecked(),
            )
            db.add(series)
            db.flush()

            if plan:
                crons, tz_raw, effective_from, ru, mr = plan
                self._persist_schedules_entity(
                    db,
                    crons=crons,
                    timezone_str=tz_raw,
                    effective_from_utc=effective_from,
                    project_id=None,
                    series_id=series.id,
                )

            episodes = bootstrap_series_episodes(db, series)
            db.commit()
            for ep in episodes:
                db.refresh(ep)
            db.refresh(series)
            self.projects = episodes
            self.project = episodes[0] if episodes else None
            self.created_series_title = stitle
            self.accept()
        finally:
            db.close()


def _build_video_type_choices() -> list[tuple[str, VideoType]]:
    return [
        ("Long-form YouTube (16:9)", VideoType.youtube_long_16_9),
        ("YouTube Shorts (vertical)", VideoType.youtube_shorts_vertical),
        ("Theory / mystery narrative (engaging)", VideoType.theory_narrative_engaging),
        ("Documentary voiceover", VideoType.documentary_voiceover),
        ("Educational explainer", VideoType.educational_explainer),
        ("Commentary / opinion", VideoType.commentary_opinion),
        ("Custom (follow notes strictly)", VideoType.custom),
    ]


VIDEO_TYPE_CHOICES = _build_video_type_choices()
