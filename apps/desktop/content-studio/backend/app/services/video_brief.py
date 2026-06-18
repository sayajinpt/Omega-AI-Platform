"""Structured brief passed to research/script/image stages so the AI respects theme, duration, and format."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.models.enums import VideoType
from app.models.tables import Series, VideoProject
from app.services.project_recent_topics import build_recent_user_projects_prompt
from app.services.scene_plan import plan_scene_durations
from app.services.series_recent_topics import build_recent_series_topics_prompt
from app.services.video_type_profile import (
    FormatArchetype,
    aspect_ratio,
    combined_pacing_notes,
    delivery_label,
    format_archetype_for,
    is_short_form,
    plan_scene_roles,
)


class VideoBrief(BaseModel):
    model_config = ConfigDict(use_enum_values=True)

    project_id: str
    title: str
    theme: str
    content_notes: str | None = None
    video_type: VideoType
    target_duration_seconds: int = Field(ge=1, le=7 * 24 * 3600)
    aspect_ratio: str
    pacing_and_structure_notes: str
    scene_durations_seconds: list[int] = Field(default_factory=list)
    include_subtitles: bool = False
    use_ai_video_title: bool = True
    series_title: str | None = None
    series_theme: str | None = None
    series_topic_dedup_window: int = Field(
        default=0,
        ge=0,
        le=500,
        description="Number of prior sibling episodes consulted for topic de-duplication (0 = disabled / not in series).",
    )
    series_recent_topics_block: str = Field(
        default="",
        description="Formatted list of recent sibling episode topics for the user prompt.",
    )
    prior_projects_dedup_window: int = Field(
        default=0,
        ge=0,
        le=500,
        description="Number of other account projects consulted for de-duplication (standalone videos).",
    )
    prior_projects_topics_block: str = Field(
        default="",
        description="Formatted list of recent projects on the account for standalone-video de-duplication.",
    )
    tts_speaker: str = "Ryan"
    tts_language: str = "English"
    narration_tone: str | None = None
    voice_gender: str = "any"
    web_research_notes: str = Field(
        default="",
        description="Plain-text web snippets injected before script LLM (server-side research).",
    )
    script_use_web_research: bool = Field(
        default=True,
        description="False = skip Tavily; script LLM uses model knowledge only (subject to SCRIPT_WEB_RESEARCH_ENABLED).",
    )
    no_image_mode: bool = Field(
        default=False,
        description=(
            "True = render flat subtitle frames (no image generation). "
            "Tells the script LLM the narration IS what appears on screen — keep lines short and sticky."
        ),
    )

    @property
    def scene_count(self) -> int:
        return len(self.scene_durations_seconds)

    @property
    def planned_total_seconds(self) -> int:
        return sum(self.scene_durations_seconds)

    @property
    def is_short_form(self) -> bool:
        return is_short_form(VideoType(self.video_type), self.target_duration_seconds)

    @property
    def is_action_montage(self) -> bool:
        return VideoType(self.video_type) == VideoType.cinematic_action_sequence

    @property
    def scene_roles(self) -> list[str]:
        return plan_scene_roles(
            self.scene_count,
            short_form=self.is_short_form,
            video_type=VideoType(self.video_type),
        )

    @property
    def format_archetype(self) -> FormatArchetype:
        """Narration tone + hook templates + pacing rules tailored to this (type, duration)."""
        return format_archetype_for(VideoType(self.video_type), self.target_duration_seconds)

    def effective_tts_instruct(self) -> str:
        """
        Voice / pacing direction to pass to Qwen TTS's ``instruct`` parameter.

        Prefers the user's explicit ``narration_tone`` when set; otherwise derives a directive
        from the format archetype (so short-form videos automatically get fast, punchy pacing
        without the operator having to type it).
        """
        from app.services.narration_tone_presets import resolve_narration_tone_for_tts

        resolved = resolve_narration_tone_for_tts(self.narration_tone)
        if resolved:
            return resolved
        return self.format_archetype.tts_instruction()

    @staticmethod
    def _words_for_seconds(seconds: int) -> tuple[int, int]:
        """
        Approximate TTS word budget per scene at a natural pace (~2.2 words/second).

        Returns (low, high) so the model has room to vary but stays inside the audible window.
        """
        sec = max(1, int(seconds))
        lo = max(2, int(round(sec * 1.9)))
        hi = max(lo + 1, int(round(sec * 2.6)))
        return lo, hi

    def _theme_is_broad_category(self) -> bool:
        """
        Heuristic: theme reads like a category (plural / generic) rather than a specific instance.

        Used to add the "pick ONE concrete instance" rule on Shorts.
        """
        raw = (self.theme or "").strip().lower()
        if not raw:
            return False
        first_line = raw.splitlines()[0].strip()
        if len(first_line) <= 60 and " " in first_line:
            words = first_line.split()
            if any(words[-1].endswith(s) for s in ("ies", "ses", "s")) and not first_line.endswith("'s"):
                return True
            broad_signals = (
                "theories",
                "stories",
                "mysteries",
                "legends",
                "myths",
                "scandals",
                "heists",
                "disasters",
                "discoveries",
                "civilizations",
                "creatures",
                "places",
                "people",
                "moments",
                "facts",
                "secrets",
                "experiments",
                "inventions",
                "ideas",
            )
            if any(w in broad_signals for w in words):
                return True
        return False

    def _render_archetype_block(self, *, compact: bool = False) -> list[str]:
        """Structured narration archetype block — appended into the system prompt."""
        arch = self.format_archetype
        if compact:
            out: list[str] = [
                f"Voice archetype: {arch.name} — {arch.descriptor}",
                f"Sentence style: {arch.sentence_style}",
            ]
            for rule in arch.pacing_rules[:3]:
                out.append(f"- {rule}")
            if arch.hook_templates:
                out.append("Hook patterns (adapt one; do not copy verbatim):")
                for tpl in arch.hook_templates[:2]:
                    out.append(f"  * {tpl}")
            if arch.forbidden_openers:
                banned = "; ".join(arch.forbidden_openers[:4])
                out.append(f"Never open with: {banned}")
            return out

        out = [
            "# NARRATION ARCHETYPE",
            f"- Archetype: {arch.name} — {arch.descriptor}",
            f"- Narration voice: {arch.narration_voice}",
            f"- Sentence style: {arch.sentence_style}",
            f"- Structural signature: {arch.structural_signature}",
            f"- Closer style: {arch.closer_style}",
            "- Pacing rules:",
        ]
        for rule in arch.pacing_rules:
            out.append(f"  * {rule}")
        out.append("- Hook templates (pick or adapt ONE — never quote a template verbatim):")
        for tpl in arch.hook_templates:
            out.append(f"  * {tpl}")
        out.append("- Forbidden openers (do NOT begin the script with any of these):")
        for bad in arch.forbidden_openers:
            out.append(f"  * {bad}")
        if arch.forbidden_registers:
            out.append(
                "- Forbidden register (do NOT use these phrases or this tone anywhere in narration_text):"
            )
            for bad in arch.forbidden_registers:
                out.append(f"  * {bad}")

        if arch.retention_pattern.strip():
            out.append("")
            out.append("# RETENTION PATTERN (apply this loop across the SCENE PLAN)")
            for ln in arch.retention_pattern.splitlines():
                out.append(ln)

        if arch.examples:
            out.append("")
            out.append("# EXAMPLES — adapt the PATTERN, not the words")
            out.append(
                "These are worked transcripts in the right voice and rhythm for this archetype. "
                "DO NOT copy their topics, phrases, dates, or names — use them as a template for "
                "how YOUR script should feel. Your actual narration must reflect the THEME / TOPIC "
                "below."
            )
            for i, ex in enumerate(arch.examples, start=1):
                out.append("")
                out.append(f"## Example {i}")
                for ln in ex.splitlines():
                    out.append(ln)

        return out

    def _llm_script_system_prompt_compact(self) -> str:
        if self.is_action_montage:
            format_kind = "action montage"
            format_rules = (
                "Many fast cuts; image_prompt carries motion; narration sparse (0–4 words on most beats)."
            )
        elif self.is_short_form:
            format_kind = "YouTube Short (vertical)"
            format_rules = (
                "Hook in ≤2s; one specific story (not a category survey); 5–12 word sentences; "
                "sticky closer. Never open with 'In this video', 'Today we'll', or 'Have you ever wondered'."
            )
        else:
            format_kind = "long-form"
            format_rules = "Cold open with a concrete claim; chapter beats follow SCENE PLAN roles."

        lines: list[str] = [
            "Write one concrete video script as JSON. Follow the user SCENE PLAN exactly.",
            f"Format: {format_kind}. {format_rules}",
        ]
        if self.is_short_form and not self.is_action_montage:
            lines.append(
                "Pick ONE sharp angle on THEME (one claim, moment, or number) — not a list of subtopics."
            )
        lines.extend(self._render_archetype_block(compact=True))
        tone = (self.narration_tone or "").strip()
        if tone:
            lines.append(f"Narration tone: {tone}.")
        if self.no_image_mode:
            lines.append(
                "NO-IMAGE mode: narration_text is the on-screen text — short, punchy lines."
            )
        elif self.include_subtitles:
            lines.append("Add concise text_overlays per scene where they reinforce the line.")
        if self.use_ai_video_title:
            lines.append("Propose a compelling public title in JSON.")
        return "\n".join(lines)

    def llm_script_system_prompt(self, *, compact: bool = False) -> str:
        if compact:
            return self._llm_script_system_prompt_compact()
        if self.is_action_montage:
            format_kind = "CINEMATIC ACTION MONTAGE (multi-shot storyboard)"
        elif self.is_short_form:
            format_kind = "SHORT-FORM (vertical / TikTok-style)"
        else:
            format_kind = "LONG-FORM"
        lines: list[str] = [
            "# ROLE",
            "You are a senior YouTube scriptwriter and short-form story producer.",
            "Your job is to design a single concrete video — not a generic overview of the topic.",
            "",
            "# WORKFLOW (in order)",
            "1. Read VIDEO PARAMETERS, THEME / TOPIC, EXTRA NOTES, and any WEB RESEARCH below.",
        ]
        if self.is_action_montage:
            lines.extend(
                [
                    "2. STORYBOARD. Break the action into many distinct camera beats — each scene is the "
                    "NEXT frame of continuous motion (chase, fight, transformation, escape).",
                    "3. VISUALS FIRST. image_prompt carries the story; narration is sparse (0–4 words on "
                    "most beats). Never narrate the entire sequence in scene 1.",
                    "4. STRUCTURE. Follow SCENE PLAN roles (ESTABLISH → CHASE BEATS → CLIMAX).",
                    "5. WRITE. Match duration_seconds exactly; one shot per scene.",
                ]
            )
        else:
            lines.extend(
                [
                    "2. NARROW THE TOPIC. If THEME is a broad category (e.g. 'alien conspiracy theories', "
                    "'ancient civilizations', 'famous heists'), PICK ONE specific instance / story / claim and "
                    "tell that single story. Never write a survey of the category, never list multiple unrelated "
                    "examples in one short video.",
                    "3. ANGLE. Choose the strongest angle for that single story (mystery, contrarian claim, untold "
                    "moment, surprising fact). State the angle implicitly through the script — not by saying "
                    "'today we'll talk about…'.",
                    "4. STRUCTURE. Map narration onto the SCENE PLAN (one scene per duration budget, in order). "
                    "Each scene has a ROLE (HOOK, SETUP, REVEAL, …) shown in the SCENE PLAN — write that beat.",
                    "5. WRITE. For each scene, set narration_text to the exact spoken line(s) for TTS, sized to "
                    "fit the scene's word budget at a natural pace. Set image_prompt to a concrete, specific "
                    "shot description (subject, setting, lighting, mood, framing).",
                ]
            )
        lines.extend(["", f"# FORMAT — {format_kind}"])
        if self.is_action_montage:
            lines.extend(
                [
                    "- Movie-style horizontal montage: many fast cuts, one generated image per beat.",
                    "- Each image_prompt must describe a NEW camera setup continuing the same action thread.",
                    "- narration_text: prefer empty string on fast beats; max one 4-word stinger when needed.",
                    "- Do NOT write essay voiceover covering the whole chase in early scenes.",
                    "- Fictional / stylized action is allowed when THEME requests it (e.g. robots, superheroes).",
                ]
            )
        elif self.is_short_form:
            lines.extend(
                [
                    "- This is a SHORT VIDEO. Total runtime is small; every second must earn attention.",
                    "- Open with a 1–2 second pattern interrupt: a specific claim, a number, a contrarian "
                    "line, or a vivid image cue. NEVER open with 'In this video…', 'Today we'll talk "
                    "about…', 'Have you ever wondered…' — those waste the hook.",
                    "- Tell ONE micro-story or surprising fact. No survey, no 'here are 3 theories'.",
                    "- Use short sentences (5–12 words). Use present tense for immediacy.",
                    "- The last 1–2 seconds should be a sticky closer (quotable line, twist, or "
                    "'what would you do?'). No 'thanks for watching'.",
                    "",
                    "# VOICE REGISTER — SHORTS (mandatory)",
                    "- Write for scroll-stopping attention: plain words, alarmist hooks, curiosity gaps, "
                    "and at least one 'what if it's true?' beat. Sound like a forbidden headline, NOT a "
                    "lecture, policy essay, or demography explainer.",
                    "- Do NOT open with disclaimers, fact-check framing, or 'here's what we actually know'. "
                    "If you must label uncertainty, use ≤6 words once near the end.",
                    "- Titles and descriptions may be punchy and click-worthy; narration must still be "
                    "understandable to a general audience without jargon.",
                ]
            )
        else:
            lines.extend(
                [
                    "- Standard long-form pacing. Cold open with a concrete scene or specific claim, then "
                    "expand. Use chapter-like beats matching the SCENE PLAN roles.",
                    "- Maintain retention with periodic hooks at act boundaries (re-frame, reveal, "
                    "counter-evidence).",
                ]
            )
        lines.append("")
        lines.extend(self._render_archetype_block())
        lines.append("")
        lines.append("# TOPIC INTERPRETATION RULES")
        if self.is_action_montage:
            lines.extend(
                [
                    "- THEME describes the action set-piece to visualize (chase, battle, transformation).",
                    "- Stay in-scene: every shot advances the same continuous sequence.",
                    "- Use image_prompt for motion, camera angle, and VFX; keep narration minimal.",
                ]
            )
        elif self.is_short_form:
            lines.extend(
                [
                    "- THEME is the rabbit hole — pick ONE sharp angle (one claim, one number, one 'they "
                    "don't want you to see').",
                    "- You may dramatize stakes and use conspiratorial curiosity ('what if', 'who profits "
                    "from your fear'). Do NOT write a neutral debunk or classroom summary.",
                    "- Ground hooks in plausible, widely-discussed facts or claims; do not invent fresh "
                    "breaking news. Uncertain claims get a micro-label once, not a lecture.",
                    "- Do NOT substitute the topic with movie franchises unless EXTRA NOTES request it.",
                ]
            )
        else:
            lines.extend(
                [
                    "- THEME and EXTRA NOTES describe a REAL-WORLD topic and angle. Default to nonfiction-style "
                    "narration (reported facts, eyewitness moments, theories, science, history).",
                    "- Do NOT substitute the topic with movie franchises, cast lists, plot summaries, or "
                    "entertainment-database content unless EXTRA NOTES explicitly request that angle.",
                    "- Do NOT invent citations, dates, or quotes you cannot ground in widely-known facts. If a "
                    "detail is uncertain, phrase it as a claim ('reports say', 'witnesses described') rather "
                    "than a hard fact.",
                ]
            )
        if self.series_title:
            lines.append("")
            lines.append("# SERIES CONTEXT")
            lines.append(
                "- This video belongs to a SERIES. Keep tone, pacing, and recurring motifs aligned with "
                "the series bible while making this episode satisfying on its own."
            )
        if self.series_recent_topics_block.strip():
            lines.append(
                "- A RECENT EPISODES list may appear in the user message. Pick a clearly distinct angle "
                "from those — no re-skinning of the same specific topic or hook."
            )
        if self.prior_projects_topics_block.strip():
            lines.append(
                "- A PRIOR PROJECTS list may appear in the user message (standalone videos). Pick a clearly "
                "distinct angle from every entry — do not repeat an existing project’s core topic or hook."
            )
        lines.append("")
        lines.append("# OUTPUT REQUIREMENTS")
        if self.use_ai_video_title:
            lines.append(
                "- Propose a compelling public YouTube title and description in the JSON output. The "
                "working VIDEO TITLE supplied by the user may be a placeholder."
            )
        else:
            lines.append(
                "- Use the supplied VIDEO TITLE as the final upload title unless EXTRA NOTES say "
                "otherwise."
            )
        if self.no_image_mode:
            lines.append(
                "- NO-IMAGE RENDER MODE: the rendered video shows only the narration text on screen "
                "(no images). `narration_text` IS the on-screen text — write it that way: short, "
                "punchy, readable in one glance. Avoid asides, hedging, or list-y phrasing."
            )
        elif self.include_subtitles:
            lines.append(
                "- Include on-screen caption text: for each scene, add concise text_overlays (3–6 word "
                "phrases) timed to beats."
            )
        else:
            lines.append(
                "- Keep text_overlays minimal or empty unless they are essential for clarity."
            )
        tone = (self.narration_tone or "").strip()
        if tone:
            lines.append(f"- Target narration tone / delivery: {tone}.")
        lines.extend(
            [
                "- Every scene with a positive duration budget MUST have substantive narration_text "
                "(for TTS) and image_prompt (for image generation). No empty strings, no 'TBD', no "
                "lorem ipsum, no generic filler.",
                "- narration_text is exactly what the TTS engine will read aloud — write it that way, "
                "no stage directions, no '[scene 1]' labels, no markdown.",
                "- image_prompt must describe a single concrete shot for the scene (who/what is on "
                "screen, environment, lighting, mood, framing). Avoid 'cinematic, high quality' filler.",
            ]
        )
        return "\n".join(lines)

    def _llm_script_user_prompt_compact(self) -> str:
        notes = (self.content_notes or "").strip() or "(none)"
        preset = delivery_label(self.video_type)
        durations = self.scene_durations_seconds
        roles = self.scene_roles
        tone_line = (self.narration_tone or "").strip()

        parts: list[str] = [
            "# VIDEO",
            f"Title: {self.title}",
            f"Format: {preset} | {self.aspect_ratio} | {self.target_duration_seconds}s | "
            f"{self.scene_count} scenes",
            f"TTS: {self.tts_language} ({self.tts_speaker}, gender {self.voice_gender})",
            f"Tone: {tone_line or '(default for format)'}",
        ]
        if self.no_image_mode:
            parts.append("Visual: NO-IMAGE — narration_text is on-screen text.")
        else:
            parts.append(
                "Subtitles: "
                + ("yes — concise text_overlays" if self.include_subtitles else "no")
            )
        parts.extend(["", "# THEME", self.theme.strip() or "(use EXTRA NOTES)", "", "# NOTES", notes, ""])

        if self.is_short_form and self._theme_is_broad_category():
            parts.extend(
                [
                    "# NARROW THE TOPIC",
                    "THEME is broad and the video is SHORT — pick ONE specific story/claim inside it "
                    "(do not survey the category).",
                    "",
                ]
            )

        parts.append("# SCENE PLAN (match order; duration_seconds per row)")
        parts.append("idx | sec | role | words (approx)")
        for i, sec in enumerate(durations):
            role = roles[i] if i < len(roles) else "DEVELOP"
            if self.is_action_montage:
                wlo, whi = 0, max(4, int(round(int(sec) * 0.4)))
            else:
                wlo, whi = self._words_for_seconds(int(sec))
            parts.append(f"  {i + 1:>2} | {int(sec):>3} | {role} | {wlo}-{whi}")
        parts.append("")

        if self.series_title:
            parts.extend(
                [
                    "# SERIES",
                    f"{self.series_title}: {self.series_theme or self.theme}",
                    "",
                ]
            )
        if self.series_recent_topics_block.strip():
            parts.extend(["# RECENT EPISODES (avoid repeating)", self.series_recent_topics_block.strip(), ""])
        if self.prior_projects_topics_block.strip():
            parts.extend(["# PRIOR PROJECTS (avoid repeating)", self.prior_projects_topics_block.strip(), ""])

        wr = (self.web_research_notes or "").strip()
        if wr:
            parts.extend(["# WEB RESEARCH", wr, ""])
        elif not self.script_use_web_research:
            parts.append("# SOURCE: model knowledge only (no live web search).")
            parts.append("")

        return "\n".join(parts)

    def llm_script_user_prompt(self, *, compact: bool = False) -> str:
        if compact:
            return self._llm_script_user_prompt_compact()
        notes = (self.content_notes or "").strip() or "(none)"
        preset = delivery_label(self.video_type)
        durations = self.scene_durations_seconds
        roles = self.scene_roles

        parts: list[str] = []

        arch = self.format_archetype
        parts.append("# VIDEO PARAMETERS")
        parts.append(f"- Working title: {self.title}")
        parts.append(f"- Format: {preset}")
        parts.append(f"- Aspect ratio: {self.aspect_ratio}")
        parts.append(f"- Target total duration: {self.target_duration_seconds} seconds")
        parts.append(f"- Scene count: {self.scene_count}")
        parts.append(f"- Narration archetype: {arch.name} — {arch.descriptor}")
        parts.append(f"- Structural signature: {arch.structural_signature}")
        parts.append(f"- Pacing guidance: {self.pacing_and_structure_notes}")
        if self.no_image_mode:
            parts.append(
                "- Visual mode: NO-IMAGE — the rendered video shows ONLY the narration text on a flat "
                "background. The `narration_text` you write IS what appears on screen, word for word. "
                "Keep lines short, punchy, and reader-friendly (max ~14 words per scene)."
            )
            parts.append(
                "- image_prompt: still required (1 short sentence) so the schema is satisfied, but it "
                "WILL NOT be used to generate any image; spend your effort on narration_text."
            )
        else:
            parts.append(
                "- Subtitles / on-screen text: "
                + ("YES — add concise text_overlays per scene where they reinforce the line."
                   if self.include_subtitles
                   else "NO — keep text_overlays minimal or empty.")
            )
        parts.append(f"- Spoken language (TTS): {self.tts_language}")
        parts.append(f"- Voice preset: {self.tts_speaker} (gender preference: {self.voice_gender})")
        tone_line = (self.narration_tone or "").strip()
        parts.append(f"- Narration tone: {tone_line or '(default for the format)'}")
        parts.append("")

        parts.append("# THEME / TOPIC")
        parts.append(self.theme.strip() or "(no theme provided — use EXTRA NOTES)")
        parts.append("")
        parts.append("# EXTRA NOTES (from user)")
        parts.append(notes)
        parts.append("")

        if self.is_short_form and self._theme_is_broad_category():
            parts.append("# CRITICAL — NARROW THE TOPIC")
            parts.append(
                "The theme above is a BROAD CATEGORY and the video is SHORT. You MUST pick ONE specific "
                "instance inside that category and tell that single story. Do not summarize the whole "
                "category."
            )
            parts.append("")
            parts.append("BAD (do not do this):")
            parts.append("  ‹‹ 'There are many alien conspiracy theories. Some say UFOs visit Earth, others "
                         "believe in Area 51 cover-ups, and some think reptilians walk among us…' ››")
            parts.append("GOOD (do this — pick one and commit):")
            parts.append("  ‹‹ HOOK: 'In 1947, something fell from the New Mexico sky — and the U.S. military "
                         "spent 70 years changing its story.' Then tell that single Roswell beat in full. ››")
            parts.append("")
            parts.append(
                "Pick a strong, well-known specific story or claim within the THEME. If unsure, choose "
                "the most visually rich one (good for image generation) and the most surprising for the "
                "viewer (good for retention)."
            )
            parts.append("")

        parts.append("# SCENE PLAN (one scene per row — match this order exactly)")
        parts.append("idx | seconds | role | narration word budget (approx)")
        for i, sec in enumerate(durations):
            role = roles[i] if i < len(roles) else "DEVELOP"
            if self.is_action_montage:
                wlo, whi = 0, max(4, int(round(int(sec) * 0.4)))
            else:
                wlo, whi = self._words_for_seconds(int(sec))
            parts.append(f"  {i + 1:>2} | {int(sec):>3}s   | {role} | {wlo}-{whi} words")
        parts.append("")
        parts.append(
            "Rules for SCENE PLAN: write each scene's narration_text to fit its word budget at a natural "
            "speaking pace (~2.2 words / second). Stay inside the word budget — under-stuffing wastes "
            "seconds, over-stuffing makes TTS rush and clip."
        )
        parts.append("")

        if self.series_title:
            parts.append("# SERIES CONTEXT")
            parts.append(f"SERIES NAME: {self.series_title}")
            parts.append(f"SERIES THEME / BIBLE: {self.series_theme or '(same as episode theme)'}")
            parts.append("")

        if self.series_recent_topics_block.strip():
            parts.append("# RECENT EPISODES (avoid repeating these specific topics / hooks)")
            parts.append(self.series_recent_topics_block.strip())
            parts.append("")

        if self.prior_projects_topics_block.strip():
            parts.append("# PRIOR PROJECTS ON THIS ACCOUNT (do not repeat these topics / hooks)")
            parts.append(self.prior_projects_topics_block.strip())
            parts.append("")

        wr = (self.web_research_notes or "").strip()
        if wr:
            parts.append("# WEB RESEARCH (cited briefs — use facts, don't copy verbatim)")
            parts.append(wr)
            parts.append("")
        elif not self.script_use_web_research:
            parts.append("# SCRIPT SOURCE MODE — MODEL KNOWLEDGE ONLY")
            parts.append(
                "No live web search was run for this project. Write from careful general knowledge "
                "aligned with THEME and EXTRA NOTES. Flag speculation as speculation; do not invent "
                "fresh breaking-news facts or citations."
            )
            parts.append("")

        parts.append("# OUTPUT")
        parts.append(
            "Return ONE JSON object only (no markdown fences, no surrounding prose) with keys "
            "`title`, `description`, `scenes[]`. `scenes` length must equal the SCENE PLAN row count, "
            "and each `duration_seconds` must equal the seconds listed in the SCENE PLAN."
        )
        return "\n".join(parts)


def _series_fields(project: VideoProject) -> tuple[str | None, str | None]:
    s: Series | None = project.series
    if not s:
        return None, None
    return s.title, s.theme


def _theme_for_brief(project: VideoProject) -> str:
    base = (project.theme or "").strip()
    topic = (getattr(project, "episode_topic", None) or "").strip()
    if topic:
        return f"{base}\n\nEpisode-specific focus: {topic}" if base else f"Episode-specific focus: {topic}"
    return base


def build_video_brief(project: VideoProject, db: Session | None = None) -> VideoBrief:
    durations = plan_scene_durations(project.max_duration_seconds, project.video_type)
    stitle, stheme = _series_fields(project)

    dedup_n_meta = 0
    if project.series_id and project.series is not None:
        dedup_n_meta = max(0, min(int(project.series.topic_dedup_recent_count or 0), 500))

    recent_block = ""
    if db is not None and dedup_n_meta > 0 and project.series_id:
        recent_block = build_recent_series_topics_prompt(
            db,
            series_id=project.series_id,
            current_project_id=project.id,
            lookback=dedup_n_meta,
        )

    prior_window = 0
    prior_block = ""
    if not project.series_id:
        raw_prior = getattr(project, "topic_dedup_recent_count", None)
        if raw_prior is not None:
            prior_window = max(0, min(int(raw_prior), 500))
        else:
            prior_window = max(0, min(int(settings.project_topic_dedup_recent_count), 500))
        if db is not None and prior_window > 0:
            prior_block = build_recent_user_projects_prompt(
                db,
                user_id=project.user_id,
                current_project_id=project.id,
                lookback=prior_window,
            )

    sw = getattr(project, "script_use_web_research", True)
    if sw is None:
        sw = True

    return VideoBrief(
        project_id=project.id,
        title=project.title,
        theme=_theme_for_brief(project),
        content_notes=project.content_notes,
        video_type=project.video_type,
        target_duration_seconds=project.max_duration_seconds,
        aspect_ratio=aspect_ratio(project.video_type),
        pacing_and_structure_notes=combined_pacing_notes(project.video_type, project.max_duration_seconds),
        scene_durations_seconds=durations,
        include_subtitles=project.include_subtitles,
        use_ai_video_title=project.use_ai_video_title,
        series_title=stitle,
        series_theme=stheme,
        series_topic_dedup_window=dedup_n_meta,
        series_recent_topics_block=recent_block,
        prior_projects_dedup_window=prior_window,
        prior_projects_topics_block=prior_block,
        tts_speaker=getattr(project, "tts_speaker", None) or "Ryan",
        tts_language=getattr(project, "tts_language", None) or "English",
        narration_tone=getattr(project, "narration_tone", None),
        voice_gender=getattr(project, "voice_gender", None) or "any",
        script_use_web_research=bool(sw),
        no_image_mode=bool(getattr(project, "no_image_mode", False)),
    )


def build_ephemeral_brief(
    *,
    theme: str,
    title: str | None = None,
    video_type: VideoType,
    max_duration_seconds: int,
    content_notes: str | None = None,
    include_subtitles: bool = False,
    narration_tone: str | None = None,
    tts_language: str = "English",
    tts_speaker: str = "Ryan",
    voice_gender: str = "any",
    no_image_mode: bool = False,
) -> VideoBrief:
    """In-memory brief for chat/agent script generation (no DB project)."""
    durations = plan_scene_durations(max_duration_seconds, video_type)
    working_title = (title or theme or "Content Studio run")[:255]
    return VideoBrief(
        project_id="ephemeral",
        title=working_title,
        theme=(theme or "").strip(),
        content_notes=content_notes,
        video_type=video_type,
        target_duration_seconds=max_duration_seconds,
        aspect_ratio=aspect_ratio(video_type),
        pacing_and_structure_notes=combined_pacing_notes(video_type, max_duration_seconds),
        scene_durations_seconds=durations,
        include_subtitles=include_subtitles,
        use_ai_video_title=True,
        tts_speaker=tts_speaker,
        tts_language=tts_language,
        narration_tone=narration_tone,
        voice_gender=voice_gender,
        script_use_web_research=False,
        no_image_mode=no_image_mode,
    )


def tts_instruct_from_brief_dict(brief_json: dict, *, override: str | None = None) -> str:
    """
    Resolve the effective Qwen TTS ``instruct`` from a serialized brief.

    Used by the pipeline runner (which only has the ``brief_json`` dict, not a live
    :class:`VideoBrief`) so the same archetype-derived default applies when the operator
    hasn't filled ``project.narration_tone``.
    """
    from app.services.narration_tone_presets import resolve_narration_tone_for_tts

    resolved = resolve_narration_tone_for_tts(override)
    if resolved:
        return resolved
    try:
        vt = VideoType(str(brief_json.get("video_type") or "").strip())
    except ValueError:
        vt = VideoType.custom
    try:
        seconds = int(brief_json.get("target_duration_seconds") or 60)
    except (TypeError, ValueError):
        seconds = 60
    return format_archetype_for(vt, seconds).tts_instruction()
