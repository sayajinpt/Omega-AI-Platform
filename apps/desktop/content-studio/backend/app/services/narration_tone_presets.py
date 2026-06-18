"""Narration-tone presets for the project / series settings UI.

These presets are shortcuts the user can pick from the desktop UI; selecting one fills the
``narration_tone`` text field with the corresponding ``instruct`` string. The field stays
free-form — picking a preset is just an autofill, the user can edit afterward, and a blank
value still means "use the archetype-derived default" (see
:func:`app.services.video_brief.tts_instruct_from_brief_dict`).

Each preset is engineered for Qwen3-TTS's ``instruct`` parameter (free-form natural-language
voice direction) and always includes a "pacing must stay consistent across the whole video"
clause when speed/energy matters — that's the safeguard against the "voice tone changes
between scenes" issue when the model is held across the whole job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class NarrationTonePreset:
    """One row in the preset dropdown."""

    key: str
    label: str
    description: str
    instruct: str


# Sentinel preset = "leave the field blank → derive from format archetype".
# UI uses this as the default selection; picking it CLEARS the tone text field.
AUTO_FROM_ARCHETYPE = NarrationTonePreset(
    key="auto",
    label="Auto — derive from format archetype (recommended)",
    description=(
        "Leave the field blank and let the pipeline pick fast/energetic pacing for Shorts, "
        "measured/cinematic for long-form, etc. Best default for most projects."
    ),
    instruct="",
)


NARRATION_TONE_PRESETS: tuple[NarrationTonePreset, ...] = (
    AUTO_FROM_ARCHETYPE,
    NarrationTonePreset(
        key="shorts_punchy",
        label="Fast & punchy (Shorts / TikTok)",
        description="Urgent, high-energy, hook-first delivery for sub-60s vertical videos.",
        instruct=(
            "Speak with fast, high-energy pacing. Urgent and confident, like the narrator "
            "just discovered something the viewer needs to hear right now. Short declarative "
            "sentences, strong verbs at the front. No throat-clearing, no caveats. Land each "
            "sentence cleanly — pacing must stay consistent across the whole video."
        ),
    ),
    NarrationTonePreset(
        key="conspiratorial_whisper",
        label="Conspiratorial / mystery whisper",
        description="Hushed, near-whisper reveal voice for mystery and unexplained-phenomena topics.",
        instruct=(
            "Hushed, conspiratorial near-whisper. Speak as if revealing forbidden knowledge. "
            "Slightly slower than normal, with deliberate micro-pauses before reveals. Lean "
            "into mystery — but stay consistent in tone scene to scene."
        ),
    ),
    NarrationTonePreset(
        key="podcast_theories_conspiracies",
        label="Podcast — theories & conspiracies (ethical curiosity)",
        description=(
            "Warm two-mic energy: curious, skeptical, never sensationalizing. For alternate "
            "history, UFO lore, and rabbit-hole topics — frame unknowns honestly."
        ),
        instruct=(
            "Warm, intimate podcast-host delivery for theories, conspiracies, and unexplained "
            "phenomena. Sound like a smart friend leaning in — curious, skeptical, never "
            "mocking witnesses. Use rhetorical questions and 'here's what we actually know' "
            "beats. Ethical guardrails: never present fiction as fact; flag speculation; "
            "no fear-mongering. Mid-tempo with natural breaths; keep the same cozy-but-sharp "
            "energy from cold open to outro — no drift into a different persona between scenes."
        ),
    ),
    NarrationTonePreset(
        key="populist_left_provocateur",
        label="Populist left — conspiracist provocateur (anti-corporate / anti-oligarch)",
        description=(
            "Sensational, provocative left-populist register: corporations, billionaires, "
            "regulatory capture, surveillance capitalism. 'They profit while you pay.' "
            "Confrontational but anti-hate."
        ),
        instruct=(
            "Confrontational, sensational left-populist provocateur. Channel a class-anger "
            "register: corporations, billionaires, lobbyists, regulatory capture, surveillance "
            "capitalism, media consolidation. Punchy 'follow the money' framing, rhetorical "
            "questions ('who profits when you panic?'), and a 'workers vs. owners' lens. "
            "Lean into outrage at SYSTEMS and POWER STRUCTURES — never at ethnicities, "
            "religions, immigrants, or any protected group. No calls to harm, no doxxing, no "
            "fabricated quotes or invented specifics; label speculation as speculation in ≤6 "
            "words once. Mid-fast pacing, strong verbs at the front of every sentence. "
            "Keep the same provocateur energy from cold open to outro — pacing and intensity "
            "must stay consistent across every scene."
        ),
    ),
    NarrationTonePreset(
        key="satirical_dark_humor",
        label="Satirical / dark-humor provocateur",
        description=(
            "Deadpan satirical narrator: dry wit, irony, gallows humor, absurdity. "
            "For commentary on scandals, tech dystopia, late-stage absurdity. Punches up, "
            "not down — never at protected groups."
        ),
        instruct=(
            "Deadpan, dry-witted satirical provocateur. Channel a gallows-humor commentator: "
            "ironic understatement, mock-cheerful delivery on grim setups, well-timed pauses "
            "before the punchline. Treat absurd realities (regulator revolving doors, terms-of-"
            "service fine print, dystopian product launches, news-cycle whiplash) as if they "
            "were perfectly normal — then let the absurdity land on its own. Punch UP at "
            "institutions, billionaires, oligarchs, propagandists, hypocrites in power — "
            "never at ethnicities, religions, immigrants, LGBTQ+ people, disabled people, or "
            "any protected group. No slurs, no stereotype humor, no calls to harm, no doxxing, "
            "no fabricated quotes attributed to real people. Sarcasm OK; cruelty toward "
            "ordinary people is not. Mid-fast pacing with deliberate beat-pauses before "
            "punchlines; keep the same dry-deadpan persona consistent across every scene — "
            "do not slip into earnestness or anger at the end."
        ),
    ),
    NarrationTonePreset(
        key="populist_right_provocateur",
        label="Populist right — conspiracist provocateur (anti-establishment / anti-elite)",
        description=(
            "Sensational, provocative right-populist register: globalist institutions, deep "
            "state, media gatekeepers, platform censorship. 'They don't want you to know.' "
            "Confrontational but anti-hate."
        ),
        instruct=(
            "Confrontational, sensational right-populist provocateur. Channel an "
            "anti-establishment register: globalist institutions, deep-state framing, "
            "media gatekeepers, platform censorship, government overreach, traditional values "
            "vs. top-down social engineering. Use 'they don't want you to know', 'common-sense "
            "vs. credentialed experts', and 'who decided this for you?' beats. Lean into "
            "outrage at INSTITUTIONS and POWER STRUCTURES — never at ethnicities, religions, "
            "immigrants, LGBTQ+ people, or any protected group. No calls to harm, no doxxing, "
            "no fabricated quotes or invented specifics; label speculation as speculation in "
            "≤6 words once. Mid-fast pacing, plain words, contrarian punch. Keep the same "
            "provocateur energy from cold open to outro — pacing and intensity must stay "
            "consistent across every scene."
        ),
    ),
    NarrationTonePreset(
        key="documentary_voiceover",
        label="Authoritative documentary voiceover",
        description="Calm, credible third-person narration for documentary and explainer formats.",
        instruct=(
            "Authoritative, measured documentary voiceover. Calm and credible — facts speak "
            "louder than emotion. Third person. Steady cadence; do not rush, do not slow down "
            "at scene boundaries. Restrained delivery, low affect."
        ),
    ),
    NarrationTonePreset(
        key="cinematic_atmospheric",
        label="Cinematic / atmospheric narrator",
        description="Slower, intimate, atmospheric pacing for long-form narrative pieces.",
        instruct=(
            "Cinematic, intimate narration. Slightly slower than conversational pace, with "
            "breathing room between sentences. Build atmosphere through pacing — not volume. "
            "Let key beats land. Keep the cadence consistent across every scene."
        ),
    ),
    NarrationTonePreset(
        key="energetic_host",
        label="Energetic host / friendly creator",
        description="Bright, conversational, mid-tempo host voice for tutorials and YouTube long-form.",
        instruct=(
            "Bright, energetic, friendly host. Conversational and direct, like talking to one "
            "person across a table. Pace fast enough to feel alive, slow enough to be "
            "understood. Sound genuinely interested in the topic. Pacing stays consistent."
        ),
    ),
    NarrationTonePreset(
        key="patient_teacher",
        label="Patient teacher / educational",
        description="Clear, unrushed delivery for tutorials, explainers, and how-tos.",
        instruct=(
            "Patient, precise, teacher-energy. Define terms clearly, never rushed. Sound like "
            "you genuinely want the listener to understand. Keep an even, consistent pace "
            "across every scene — no hurried transitions."
        ),
    ),
    NarrationTonePreset(
        key="punchy_commentary",
        label="Punchy commentary / opinion",
        description="Direct, opinionated, mid-fast pacing for op-ed style or first-person commentary.",
        instruct=(
            "Direct, opinionated, but fair. Punchy beats, confident delivery. Heat without "
            "smoke — own each statement. Stable pacing across scenes; don't drift slower at "
            "the end."
        ),
    ),
    NarrationTonePreset(
        key="dramatic_narrator",
        label="Dramatic / theatrical narrator",
        description="Strong rhythm, deliberate pauses before reveals — for thrillers and reveals.",
        instruct=(
            "Dramatic, theatrical narration. Strong rhythm. Lift on key words; dramatic "
            "micro-pauses before reveals. Feel weighty, not melodramatic. Keep that rhythm "
            "consistent every scene — do not soften at the end."
        ),
    ),
    NarrationTonePreset(
        key="asmr_bedtime",
        label="ASMR / bedtime story (slow & soft)",
        description="Slow, soft-spoken, soothing — for sleep content and meditation videos.",
        instruct=(
            "Slow, calm, soft-spoken — bedtime-story warmth. Gentle pacing with relaxed "
            "breaths. Soothing and grounded. Maintain the same gentle pace across every scene."
        ),
    ),
    NarrationTonePreset(
        key="news_anchor",
        label="News anchor / serious reporter",
        description="Crisp, neutral, even-toned news delivery.",
        instruct=(
            "Crisp, neutral, news-anchor delivery. Even pace, even volume. No editorializing "
            "in the voice; the facts carry the weight. Consistent cadence across all scenes."
        ),
    ),
    NarrationTonePreset(
        key="energetic_sports",
        label="Energetic sports / hype",
        description="High-volume, hype-driven delivery for sports clips, recaps, montages.",
        instruct=(
            "Energetic, hype-driven, sports-broadcaster delivery. Fast pace, peaks on payoff "
            "lines. Sound like the play of the year is happening right now. Keep the energy "
            "high from first scene to last."
        ),
    ),
)


# Tokens from chat briefing chips / regex (``content-studio-brief.ts``) → desktop preset keys.
NARRATION_TONE_CHAT_ALIASES: dict[str, str] = {
    "conspiracy": "conspiratorial_whisper",
    "conspirac": "conspiratorial_whisper",
    "mysterious": "conspiratorial_whisper",
    "documentary": "documentary_voiceover",
    "doc": "documentary_voiceover",
    "dramatic": "dramatic_narrator",
    "educational": "patient_teacher",
    "edu": "patient_teacher",
    "podcast": "podcast_theories_conspiracies",
    "podcaster": "podcast_theories_conspiracies",
    "political": "punchy_commentary",
    "warm": "energetic_host",
    "horror": "cinematic_atmospheric",
    "comedic": "satirical_dark_humor",
    "funny": "satirical_dark_humor",
    "neutral": "documentary_voiceover",
    "sarcastic": "satirical_dark_humor",
    "authoritative": "documentary_voiceover",
}


def preset_by_key(key: str) -> NarrationTonePreset | None:
    """Return the preset with the matching ``key``, or ``None`` when unknown."""
    k = (key or "").strip().lower()
    if not k:
        return None
    for p in NARRATION_TONE_PRESETS:
        if p.key.lower() == k:
            return p
    return None


def resolve_narration_tone_for_tts(text: str | None) -> str | None:
    """
    Turn stored ``project.narration_tone`` into a Qwen3 ``instruct`` string.

    Chat briefing often saves one-word chips (``conspiracy``, ``documentary``) — those are
    not valid voice-direction on their own and can yield near-silent TTS. Map them to the
    full preset ``instruct`` text from :data:`NARRATION_TONE_PRESETS`.

    Returns ``None`` when the field is blank / auto so callers fall back to the format archetype.
    """
    raw = (text or "").strip()
    if not raw:
        return None

    direct = preset_by_key(raw)
    if direct and direct.instruct.strip():
        return direct.instruct.strip()

    stored = preset_for_instruct(raw)
    if stored and stored.instruct.strip() and stored.key != "auto":
        return stored.instruct.strip()

    # Multi-word / long free-form from the UI or chat — do not rewrite via substring aliases.
    if len(raw) >= 32 or len(raw.split()) >= 4:
        return raw

    token = raw.lower().split()[0].rstrip(".,;:")
    alias_key = NARRATION_TONE_CHAT_ALIASES.get(token) or NARRATION_TONE_CHAT_ALIASES.get(raw.lower())
    if alias_key:
        alias_preset = preset_by_key(alias_key)
        if alias_preset and alias_preset.instruct.strip():
            return alias_preset.instruct.strip()

    if len(raw) <= 28:
        for needle, alias_key in NARRATION_TONE_CHAT_ALIASES.items():
            if needle in raw.lower():
                alias_preset = preset_by_key(alias_key)
                if alias_preset and alias_preset.instruct.strip():
                    return alias_preset.instruct.strip()

    return raw


def preset_for_instruct(instruct: str | None) -> NarrationTonePreset | None:
    """
    Reverse lookup: given a stored ``narration_tone`` text, return the preset whose
    ``instruct`` matches verbatim. Used by the UI to highlight the active preset on load —
    falls back to ``None`` (i.e. "Custom / hand-edited") if no exact match.
    """
    text = (instruct or "").strip()
    if not text:
        return AUTO_FROM_ARCHETYPE
    base = strip_voice_controls_block(text)
    for p in NARRATION_TONE_PRESETS:
        if p.instruct and p.instruct.strip() == base:
            return p
    return None


# --- Structured dimension presets (emotion / speed / pitch / accent / delivery) -----------

STYLE_KEY_AUTO = "auto"

# Split marker between the main narration instruct and the machine-composed control block.
VOICE_CONTROLS_SPLIT = "\n---\nVoice controls"

VOICE_STYLE_DIM_ORDER: tuple[str, ...] = ("emotion", "speed", "pitch", "accent", "delivery")


@dataclass(frozen=True)
class VoiceStyleOption:
    """One row in a dimension combo (key, UI label, bullet line for the composed instruct)."""

    key: str
    label: str
    bullet: str


VOICE_STYLE_DIMENSIONS: dict[str, tuple[VoiceStyleOption, ...]] = {
    "emotion": (
        VoiceStyleOption(STYLE_KEY_AUTO, "Auto — (no extra emotion tag)", ""),
        VoiceStyleOption("neutral", "Neutral / even", "Emotion: neutral, even affect — no performative highs or lows."),
        VoiceStyleOption("warm", "Warm & inviting", "Emotion: warm, inviting, slightly conspiratorial curiosity."),
        VoiceStyleOption("serious", "Serious / grave", "Emotion: serious, weighty — let silences carry meaning."),
        VoiceStyleOption("playful", "Playful / wry", "Emotion: playful, wry — light irony without mockery."),
        VoiceStyleOption("urgent", "Urgent / alarmed", "Emotion: urgent, alarmed — controlled panic, not shouting."),
        VoiceStyleOption("melancholic", "Melancholic", "Emotion: melancholic, reflective — soft ache in the voice."),
    ),
    "speed": (
        VoiceStyleOption(STYLE_KEY_AUTO, "Auto — (no extra speed tag)", ""),
        VoiceStyleOption("very_slow", "Very slow", "Speed: very slow, deliberate — each word earns its place."),
        VoiceStyleOption("slow", "Slightly slow", "Speed: slightly slower than conversational for clarity."),
        VoiceStyleOption("normal", "Normal conversational", "Speed: normal conversational pacing."),
        VoiceStyleOption("fast", "Fast / brisk", "Speed: fast, brisk — keep articulation crisp."),
        VoiceStyleOption("very_fast", "Very fast", "Speed: very fast, high-information density — still intelligible."),
    ),
    "pitch": (
        VoiceStyleOption(STYLE_KEY_AUTO, "Auto — (no extra pitch tag)", ""),
        VoiceStyleOption("low", "Low register", "Pitch: low, chest-resonant register."),
        VoiceStyleOption("mid", "Mid register", "Pitch: mid, natural speaking register."),
        VoiceStyleOption("high", "Higher / brighter", "Pitch: slightly higher, brighter timbre."),
    ),
    "accent": (
        VoiceStyleOption(STYLE_KEY_AUTO, "Auto — (no strong accent steer)", ""),
        VoiceStyleOption("neutral", "Neutral / unmarked", "Accent: neutral broadcast English (unmarked region)."),
        VoiceStyleOption("us_general", "US — General American", "Accent: General American English."),
        VoiceStyleOption("us_southern", "US — Southern (soft)", "Accent: soft Southern US inflection, not caricature."),
        VoiceStyleOption("uk_rp", "UK — RP / neutral British", "Accent: neutral British (RP-adjacent, not posh caricature)."),
        VoiceStyleOption("uk_scottish", "UK — Scottish (soft)", "Accent: soft Scottish English lilt."),
        VoiceStyleOption("irish", "Irish (soft)", "Accent: soft Irish English."),
        VoiceStyleOption("australian", "Australian", "Accent: Australian English."),
        VoiceStyleOption("indian_english", "Indian English", "Accent: Indian English rhythm and vowels."),
        VoiceStyleOption("latin_us", "Latin American English", "Accent: Latin American English (bilingual-friendly)."),
        VoiceStyleOption("french_english", "French-influenced English", "Accent: subtle French-influenced English cadence."),
    ),
    "delivery": (
        VoiceStyleOption(STYLE_KEY_AUTO, "Auto — (no extra delivery tag)", ""),
        VoiceStyleOption("conversational", "Conversational", "Delivery: conversational, like a 1:1 chat."),
        VoiceStyleOption("storytelling", "Storytelling", "Delivery: storytelling — clear beats, micro-pauses on turns."),
        VoiceStyleOption("broadcast", "Broadcast / announcer", "Delivery: broadcast clarity — crisp consonants, steady level."),
        VoiceStyleOption("intimate_podcast", "Intimate podcast", "Delivery: intimate podcast proximity — close-mic warmth."),
        VoiceStyleOption("documentary", "Documentary flat", "Delivery: documentary flatness — authority without drama."),
        VoiceStyleOption("whispery", "Soft / breath-forward", "Delivery: soft, breath-forward — ASMR-adjacent but intelligible."),
    ),
}


def default_voice_style_dict() -> dict[str, str]:
    """All dimensions + main preset at ``auto`` — JSON-safe string values."""
    out = {k: STYLE_KEY_AUTO for k in VOICE_STYLE_DIM_ORDER}
    out["main"] = STYLE_KEY_AUTO
    return out


def voice_style_for_persist(style: dict[str, Any] | None) -> dict[str, str] | None:
    """Return ``None`` when style matches the all-auto default (keeps DB rows compact)."""
    st = normalize_voice_style_dict(style)
    return None if st == default_voice_style_dict() else st


def normalize_voice_style_dict(raw: dict[str, Any] | None) -> dict[str, str]:
    """Coerce arbitrary JSON into canonical string keys; unknown keys dropped."""
    base = default_voice_style_dict()
    if not isinstance(raw, dict):
        return base
    for k in ("main", *VOICE_STYLE_DIM_ORDER):
        v = raw.get(k)
        if isinstance(v, str) and v.strip():
            base[k] = v.strip().lower()
    return base


def strip_voice_controls_block(text: str) -> str:
    """Return ``narration_tone`` text without the trailing Voice controls appendix (if any)."""
    s = (text or "").strip()
    if VOICE_CONTROLS_SPLIT in s:
        return s.split(VOICE_CONTROLS_SPLIT, 1)[0].rstrip()
    return s


def _dimension_bullet(dim: str, choice_key: str) -> str | None:
    if not choice_key or choice_key == STYLE_KEY_AUTO:
        return None
    opts = VOICE_STYLE_DIMENSIONS.get(dim)
    if not opts:
        return None
    for o in opts:
        if o.key == choice_key:
            return o.bullet.strip() or None
    return None


def compose_voice_control_lines(style: dict[str, str]) -> list[str]:
    """Bullet lines for the Voice controls block only (no header)."""
    lines: list[str] = []
    st = normalize_voice_style_dict(style)
    for dim in VOICE_STYLE_DIM_ORDER:
        b = _dimension_bullet(dim, st.get(dim, STYLE_KEY_AUTO))
        if b:
            lines.append(b)
    return lines


def compose_voice_controls_appendix(style: dict[str, str]) -> str:
    """The ``\\n---\\nVoice controls…`` appendix, or empty string when every dimension is auto."""
    lines = compose_voice_control_lines(style)
    if not lines:
        return ""
    return (
        f"{VOICE_CONTROLS_SPLIT} (apply consistently across every scene — same energy and "
        f"cadence start to finish):\n• " + "\n• ".join(lines)
    )


def compose_full_narration_instruct(style: dict[str, Any] | None) -> str:
    """
    Build the full ``narration_tone`` / TTS instruct string from main preset + dimensions.

    Returns ``\"\"`` when everything is ``auto`` (caller should clear the field so the
    pipeline falls back to the format archetype).
    """
    st = normalize_voice_style_dict(style)
    main = st.get("main", STYLE_KEY_AUTO)
    main_text = ""
    if main and main != STYLE_KEY_AUTO:
        p = preset_by_key(main)
        if p and p.instruct.strip():
            main_text = p.instruct.strip()
    appendix = compose_voice_controls_appendix(st)
    if not main_text and not appendix:
        return ""
    if main_text and appendix:
        return main_text + appendix
    return main_text or appendix.strip()


def merge_custom_base_with_style(user_text: str, style: dict[str, Any] | None) -> str:
    """
    When the UI main preset is ``Custom``, keep the user's hand-typed base text and only
    replace / append the Voice controls block from ``style``.
    """
    base = strip_voice_controls_block(user_text)
    appendix = compose_voice_controls_appendix(normalize_voice_style_dict(style))
    if not base and not appendix:
        return ""
    if not appendix:
        return base
    if not base:
        return appendix.strip()
    return base + appendix
