"""Presentation + pacing presets per logical video type."""

from __future__ import annotations

from dataclasses import dataclass, replace

from app.models.enums import VideoType

VIDEO_TYPE_PROFILES: dict[
    VideoType,
    dict[str, str | tuple[int, int] | int],
] = {
    VideoType.youtube_long_16_9: {
        "aspect_ratio": "16:9",
        "delivery": "youtube_long",
        "min_scene_sec": 12,
        "max_scene_sec": 90,
        "pacing_summary": (
            "Standard long-form YouTube: clear hook in scene 1, chapters via pacing, "
            "scene lengths typically 20–75s unless the topic demands shorter beats."
        ),
    },
    VideoType.youtube_shorts_vertical: {
        "aspect_ratio": "9:16",
        "delivery": "youtube_shorts",
        "min_scene_sec": 3,
        "max_scene_sec": 18,
        "pacing_summary": (
            "Vertical short-form: immediate hook, rapid cuts implied by shorter scenes, "
            "keep narration dense; total runtime must stay within the user's target duration."
        ),
    },
    VideoType.documentary_voiceover: {
        "aspect_ratio": "16:9",
        "delivery": "youtube_long",
        "min_scene_sec": 15,
        "max_scene_sec": 120,
        "pacing_summary": (
            "Documentary voiceover: authoritative tone, slower narration density, "
            "prefer fewer longer scenes when covering complex ideas."
        ),
    },
    VideoType.educational_explainer: {
        "aspect_ratio": "16:9",
        "delivery": "youtube_long",
        "min_scene_sec": 10,
        "max_scene_sec": 75,
        "pacing_summary": (
            "Educational explainer: define terms early, one main idea per scene, "
            "use transitions to signal section changes."
        ),
    },
    VideoType.commentary_opinion: {
        "aspect_ratio": "16:9",
        "delivery": "youtube_long",
        "min_scene_sec": 8,
        "max_scene_sec": 60,
        "pacing_summary": (
            "Commentary / opinion: punchy beats, thesis early, counterpoints mid-video, "
            "conclusion with a clear takeaway."
        ),
    },
    VideoType.theory_narrative_engaging: {
        "aspect_ratio": "16:9",
        "delivery": "youtube_long",
        "min_scene_sec": 12,
        "max_scene_sec": 90,
        "pacing_summary": (
            "Theory / mystery / narrative: strong cold open, curiosity loops, clear signposting, "
            "payoffs and ethical framing; keep tension without misleading the viewer."
        ),
    },
    VideoType.cinematic_action_sequence: {
        "aspect_ratio": "16:9",
        "delivery": "custom",
        "min_scene_sec": 3,
        "max_scene_sec": 12,
        "pacing_summary": (
            "Cinematic action / movie-style montage: many distinct shots (one image per beat), "
            "fast cuts, horizontal 16:9 framing, sparse or ambient narration — visuals carry the "
            "story. Each scene is the NEXT frame of continuous action (chase, fight, transformation)."
        ),
    },
    VideoType.custom: {
        "aspect_ratio": "16:9",
        "delivery": "custom",
        "min_scene_sec": 8,
        "max_scene_sec": 120,
        "pacing_summary": (
            "Custom format: follow user theme and notes strictly; choose scene lengths "
            "that fit the stated tone while matching the target duration."
        ),
    },
}


def scene_duration_bounds(video_type: VideoType) -> tuple[int, int]:
    profile = VIDEO_TYPE_PROFILES[video_type]
    lo = int(profile["min_scene_sec"])
    hi = int(profile["max_scene_sec"])
    return lo, hi


def aspect_ratio(video_type: VideoType) -> str:
    return str(VIDEO_TYPE_PROFILES[video_type]["aspect_ratio"])


def pacing_notes(video_type: VideoType) -> str:
    return str(VIDEO_TYPE_PROFILES[video_type]["pacing_summary"])


def duration_format_notes(target_seconds: int) -> str:
    """Extra pacing guidance from total runtime (orthogonal to aspect / delivery type)."""
    s = int(target_seconds)
    if s <= 45:
        return (
            "Micro / Shorts-length total runtime: prioritize a single hook, one twist or punchline, "
            "and zero filler; every line must earn attention."
        )
    if s <= 180:
        return (
            "Short vertical-friendly runtime: one tight arc, immediate pattern interrupt in the first "
            "1–2 seconds, rapid narration, no slow exposition."
        )
    if s <= 600:
        return (
            "Medium runtime (~10 min or less): one main thesis, 2–4 acts, recurring motif; "
            "still keep hooks at act boundaries."
        )
    if s <= 20 * 60:
        return (
            "Long-form (~20 min): multi-chapter narrative, deeper evidence beats, callbacks, "
            "and deliberate slower sections balanced with retention spikes."
        )
    return (
        "Extended runtime: episodic structure with chapter markers, recurring themes, "
        "and occasional recap beats so viewers can join mid-video."
    )


def combined_pacing_notes(video_type: VideoType, target_seconds: int) -> str:
    return pacing_notes(video_type) + " " + duration_format_notes(target_seconds)


VIDEO_TYPE_DELIVERY_LABEL: dict[VideoType, str] = {
    VideoType.youtube_long_16_9: "standard long-form YouTube (16:9)",
    VideoType.youtube_shorts_vertical: "vertical Shorts / TikTok-style (9:16), hook-first",
    VideoType.documentary_voiceover: "documentary voiceover (16:9)",
    VideoType.educational_explainer: "educational explainer (16:9)",
    VideoType.commentary_opinion: "commentary / opinion (16:9)",
    VideoType.theory_narrative_engaging: "theory / mystery / narrative engagement (16:9)",
    VideoType.cinematic_action_sequence: "cinematic action montage / movie-style sequence (16:9, multi-shot)",
    VideoType.custom: "custom format (follow user notes closely)",
}


def delivery_label(video_type: VideoType) -> str:
    return VIDEO_TYPE_DELIVERY_LABEL.get(video_type, str(video_type))


def video_format_summary(video_type: VideoType, target_seconds: int) -> str:
    """One line for LLM + research: ties duration bucket to format preset."""
    lab = delivery_label(video_type)
    bucket = duration_format_notes(target_seconds)
    return f"Format: {lab}. Runtime target: ~{int(target_seconds)}s total. {bucket}"


def is_short_form(video_type: VideoType, target_seconds: int) -> bool:
    """True when the project should be treated as a Shorts / TikTok-style short video."""
    if video_type == VideoType.youtube_shorts_vertical:
        return True
    return int(target_seconds) <= 60


def plan_scene_roles(
    scene_count: int,
    *,
    short_form: bool,
    video_type: VideoType | None = None,
) -> list[str]:
    """
    Assign a narrative role to each scene so the LLM knows what each beat is for.

    Shorts use a hook→setup→twist→payoff arc; long-form uses cold open + acts + payoff/CTA.
    Action montages use sequential shot labels (establish → chase beats → climax).
    """
    if video_type == VideoType.cinematic_action_sequence:
        return _action_montage_scene_roles(scene_count)
    if scene_count <= 0:
        return []
    if scene_count == 1:
        return ["HOOK+PAYOFF (entire video in one beat — punchline matters)"]
    if short_form:
        if scene_count == 2:
            return ["HOOK (open with a pattern-interrupt question or claim)", "PAYOFF (deliver the surprise + visual punchline)"]
        if scene_count == 3:
            return [
                "HOOK (≤2 s pattern interrupt; specific claim, no filler intro)",
                "REVEAL (deliver the core fact / story moment)",
                "PAYOFF (twist, CTA, or memorable closer)",
            ]
        if scene_count == 4:
            return [
                "HOOK (≤2 s pattern interrupt)",
                "SETUP (one sentence of context)",
                "REVEAL (the surprising fact / claim / moment)",
                "PAYOFF (twist + 2-3 word closer that sticks)",
            ]
        roles = ["HOOK (≤2 s pattern interrupt — specific, contrarian, or visceral)"]
        develop_count = scene_count - 3
        for i in range(develop_count):
            roles.append(f"DEVELOP {i + 1} (escalate detail, no recap)")
        roles.append("TWIST (the line viewers will quote / replay)")
        roles.append("PAYOFF (one-line closer + soft CTA; no 'thanks for watching')")
        return roles

    roles = ["COLD OPEN (hook in ≤8 s with a specific claim or scene, never a topic intro)"]
    if scene_count >= 4:
        roles.append("CONTEXT (concise background — who/when/why this matters)")
        middle = scene_count - 3
        for i in range(middle):
            roles.append(f"ACT {i + 1} (one new beat / piece of evidence; advance the argument)")
        roles.append("TURN (re-frame, counter-evidence, or emotional pivot)")
        roles.append("PAYOFF + CTA (conclusion, takeaway, soft CTA)")
    else:
        roles.extend(["DEVELOP", "PAYOFF + CTA"][: scene_count - 1])
    return roles[:scene_count]


def _action_montage_scene_roles(scene_count: int) -> list[str]:
    if scene_count <= 0:
        return []
    if scene_count == 1:
        return ["HERO SHOT (single iconic action frame)"]
    roles: list[str] = ["ESTABLISH (wide — location, threat, or hero vehicle/character before motion)"]
    if scene_count == 2:
        roles.append("PAYOFF (impact / escape / transformation hero frame)")
        return roles
    climax_idx = scene_count - 1
    turn_idx = max(2, scene_count - 2)
    for i in range(1, scene_count):
        if i == climax_idx:
            roles.append("CLIMAX (biggest stunt, explosion, transformation, or narrow escape)")
        elif i == turn_idx and scene_count >= 4:
            roles.append("TURN (unexpected obstacle — blockade, flip, reveal, ally/enemy)")
        else:
            roles.append(f"CHASE BEAT {i} (new camera angle + motion — must continue from prior frame)")
    return roles[:scene_count]


# ---------------------------------------------------------------------------
# Format archetypes — narration tone + hook templates + pacing rules per
# (video_type, duration) combination. The LLM gets a structured “archetype”
# block so its narration style matches the actual format being produced.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FormatArchetype:
    """Narration archetype the script LLM should emulate for this format + duration."""

    name: str
    descriptor: str
    narration_voice: str
    sentence_style: str
    structural_signature: str
    closer_style: str
    pacing_rules: tuple[str, ...]
    hook_templates: tuple[str, ...]
    forbidden_openers: tuple[str, ...]
    forbidden_registers: tuple[str, ...] = ()
    retention_pattern: str = ""
    examples: tuple[str, ...] = ()

    def tts_instruction(self) -> str:
        """
        One-paragraph natural-language directive to feed Qwen TTS's ``instruct`` parameter.

        Qwen3-TTS treats this as a free-form voice/pacing description (energy, cadence,
        sentence-length). We combine the archetype's voice / sentence-style / pacing into
        a single compact paragraph; that's enough for the model to lock onto the right
        pace and tone consistently across all scenes — critical for short-form videos
        where the default neutral cadence sounds dragging.
        """
        name = self.name.upper()
        if name.startswith("SHORTS"):
            speed_word, energy_word = "fast", "high-energy"
        elif "MICRO" in name:
            speed_word, energy_word = "brisk", "energetic"
        elif "STANDARD" in name:
            speed_word, energy_word = "moderate", "engaged"
        elif "CINEMATIC" in name:
            speed_word, energy_word = "measured", "intimate"
        else:
            speed_word, energy_word = "deliberate", "patient"
        voice = self.narration_voice.strip().rstrip(".")
        sentence_style = self.sentence_style.strip().rstrip(".")
        return (
            f"Speak with {speed_word}, {energy_word} pacing. {voice}. "
            f"Delivery: {sentence_style}. Land each sentence cleanly; "
            "do not slow down at scene boundaries — pacing must stay consistent "
            "across the whole video."
        )


_FORBIDDEN_GENERIC = (
    "In this video…",
    "Today we'll talk about…",
    "Have you ever wondered…",
    "Welcome back to the channel",
    "Hi everyone,",
    "Make sure to like and subscribe",
    "So, …",
    "Alright, …",
)

# Debunker / policy-essay phrasing that kills Shorts retention (sounds like a lecture, not a hook).
_FORBIDDEN_FORMAL_SHORTS = (
    "Here's what we actually know",
    "mainstream sources",
    "demographer",
    "census offices",
    "according to experts",
    "it is important to note",
    "let me explain",
    "in conclusion",
    "to be clear",
    "speculation",
    "reality check",
    "panic vs",
    "versus what",
    "verify sources",
    "follow the money",
    "breathe —",
    "skim primary charts",
)


SHORTS_HOOK_DRIVEN = FormatArchetype(
    name="SHORTS_HOOK_DRIVEN",
    descriptor="High-retention, hook-driven vertical short-form documentary",
    narration_voice=(
        "Urgent, confident, slightly conspiratorial — scroll-stopping alarmism with plain words "
        "a teenager understands. You are NOT a policy analyst, journalist, or teacher. Sound like "
        "someone whispering a forbidden headline, then daring the viewer: what if it's true?"
    ),
    sentence_style=(
        "Short, declarative, image-rich. Grade-8 vocabulary max unless the word IS the hook "
        "(e.g. Roswell, Area 51). Strong verbs first; cut filler. One idea per sentence."
    ),
    structural_signature="HOOK → SPECIFIC FACT → SUPPORTING DETAIL → TWIST/STING → STICKY CLOSER",
    closer_style=(
        "End on ONE sticky line: a quotable claim, an unanswered question, or a sharp "
        "'what would you do?'. Never end with 'thanks for watching' or 'subscribe'."
    ),
    pacing_rules=(
        "Cold-open hook in ≤2 seconds. The first 5 spoken words must contain a specific noun "
        "(a date, a name, a place, or a number).",
        "Aim for one new concrete fact or image every 3–5 words. Cut every connective word that "
        "does not carry information.",
        "Use present tense for immediacy. Avoid 'It is believed that…' — say 'They believe' or "
        "just state it.",
        "Sentences ≤12 words. Two short sentences beat one long one.",
        "No recap, no 'let me tell you about', no list framing like 'here are three theories'.",
        "Sensationalize the STAKES, not the facts: fear, secrecy, hidden numbers, 'they' hiding "
        "something — then land ONE sharp 'what if' beat (e.g. 'What if the chart they hide proves "
        "the opposite?').",
        "Ethics in one micro-beat only (≤6 words), never as the opener: e.g. 'Unverified — but "
        "listen.' or 'Conspiracy claim — still.' Do NOT write a debunk essay or policy explainer.",
    ),
    hook_templates=(
        "The disturbing truth about {topic}.",
        "Why isn't anyone talking about {specific_thing}?",
        "In {year}, {specific_event} — and {who} spent decades changing the story.",
        "{Number} of {nouns} vanished in {place}. The official explanation makes no sense.",
        "Everyone's heard of {famous_thing}. Almost no one knows {specific_related_secret}.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    forbidden_registers=_FORBIDDEN_FORMAL_SHORTS,
    retention_pattern=(
        "7-step retention loop — EVERY scene serves one of these steps:\n"
        "  1. COLD OPEN — break an assumption in ≤2 s ('There's a glitch in human history.')\n"
        "  2. CONCRETE FACT — a date, name, number, or place that anchors the claim\n"
        "  3. CONTRADICTION — the official story, then 'wrong' / 'not quite' / 'here's the part they don't say'\n"
        "  4. EVIDENCE — one visual proof: a diary line, a photo detail, a record, a screenshot\n"
        "  5. QUESTION — pose the unresolved curiosity in 5–10 words\n"
        "  6. EMOTIONAL PUNCH — a single line that spikes dopamine (taboo, eerie, or 'this part will get me banned')\n"
        "  7. ABRUPT CUTOFF — sticky closer + forced follow ('Part 2 →', 'Settings → Privacy → off. NOW.')"
    ),
    examples=(
        # Example A — historical mystery (45 s)
        "EXAMPLE A — Historical mystery — 'The missing 11 days nobody explains' (≈45 s)\n"
        "  [0:00] (HOOK)  'There's a glitch — in human history.'\n"
        "  [0:03] (FACT)  'September 3rd, 1752. Never happened. Neither did the 4th. Or the 5th.'\n"
        "  [0:10] (CONTRADICTION)  'They told you it was a calendar reform.'\n"
        "  [0:14] (EVIDENCE)  'But people rioted. Burned papers. Demanded their eleven days back.'\n"
        "  [0:21] (EVIDENCE)  'One farmer's diary: \"The sun rose twice on the same morning.\"'\n"
        "  [0:28] (QUESTION)  'So what happened during those 264 hours?'\n"
        "  [0:33] (PUNCH)  'Every major religion has a missing-time story. That's not a coincidence.'\n"
        "  [0:40] (CUTOFF)  'Part 2 will get me banned. →'",
        # Example B — modern tech (50 s)
        "EXAMPLE B — Modern tech — 'Your phone isn't listening — it's worse' (≈50 s)\n"
        "  [0:00] (HOOK)  'You talked about pizza. The ad showed up. That's not the microphone.'\n"
        "  [0:06] (CONTRADICTION)  'Everyone blames the mic. Everyone's wrong.'\n"
        "  [0:10] (FACT)  'Page 47, line 12 of the terms you accepted. Keystroke logging.'\n"
        "  [0:16] (EVIDENCE)  'Every pause. Every backspace. Every typo you didn't send.'\n"
        "  [0:22] (EVIDENCE)  'You typed \"pizza\" to a friend — and your friend's phone got the ad.'\n"
        "  [0:30] (PUNCH)  'You never said a word. But you thought about saying it.'\n"
        "  [0:36] (QUESTION)  'Still want autocorrect on?'\n"
        "  [0:40] (CUTOFF)  'Settings → Privacy → Analytics → off. NOW.'",
        # Example C — unexplained phenomenon (55 s)
        "EXAMPLE C — Unexplained phenomenon — 'The lighthouse that vanished' (≈55 s)\n"
        "  [0:00] (HOOK)  'December 15th, 1900. Three lighthouse keepers. Gone.'\n"
        "  [0:05] (FACT)  'Eilean Mor. Fully stocked. Lamps still burning.'\n"
        "  [0:10] (EVIDENCE)  'No storm. No distress signal. Just empty beds.'\n"
        "  [0:16] (EVIDENCE)  'Last log entry: \"Storm over. Sea calm. God is over all.\"'\n"
        "  [0:22] (CONTRADICTION)  'But the entry before that just said — \"I am weeping.\"'\n"
        "  [0:28] (EVIDENCE)  'One chair knocked over. Clock stopped at 11:47. A coat — still wet.'\n"
        "  [0:36] (QUESTION)  'The ocean was glass that day. So what soaked the coat?'\n"
        "  [0:42] (PUNCH)  'The rescue report said: door locked from the inside.'\n"
        "  [0:48] (CUTOFF)  'Part 2 — the recording they sealed. →'",
        # Example D — migration panic (BAD vs GOOD register for the same topic)
        "EXAMPLE D — Migration / replacement panic — register contrast (≈30 s)\n"
        "  BAD narration (too formal — do NOT write like this):\n"
        "    '2024 feeds scream invasion — yet census offices track births, deaths, visas.'\n"
        "    'Here's what we actually know — migrants cluster where jobs opened…'\n"
        "    'Mainstream sources call that speculation.'\n"
        "  GOOD narration (hook + alarm + what-if — write like THIS):\n"
        "    [HOOK]  'Your feed says invasion. One number they never put on screen.'\n"
        "    [FACT]  'Births down. Visas up. Same graph — two stories.'\n"
        "    [TURN]  'They call it replacement theory. What if the chart they're hiding says the quiet part out loud?'\n"
        "    [PUNCH] 'Someone profits every time you're scared. Who?'\n"
        "    [CUT]   'Part 2 — the spreadsheet they deleted. →'",
    ),
)


MICRO_NARRATIVE = FormatArchetype(
    name="MICRO_NARRATIVE",
    descriptor="Tight 1–3 minute mini-doc — one story, one twist, no filler",
    narration_voice=(
        "Confident storyteller. Slightly slower than a 30-second short — enough room to build a "
        "small arc, not enough for digressions or qualifiers."
    ),
    sentence_style=(
        "Punchy with breathing room. Verbs lead the sentence. Vary length but never over-explain."
    ),
    structural_signature="HOOK → STAKES → ESCALATION → TURN → PAYOFF",
    closer_style=(
        "One line that re-frames the opening. Optional soft CTA in the last 3 words "
        "('think about that')."
    ),
    pacing_rules=(
        "Open with a specific, visceral image or claim in ≤4 seconds.",
        "Introduce ONE character or moment, escalate it, deliver ONE turn, close hard.",
        "Average ~2 new beats every 10 seconds. No background section longer than 8 seconds.",
        "Sentences ≤16 words. Mix short and medium; never sprawling.",
    ),
    hook_templates=(
        "{Specific person} did {specific action}. {Years} later, nobody can explain it.",
        "There is a {place} that {something inexplicable}. Here's the part the official record "
        "leaves out.",
        "In {year}, {specific event} happened. The cover-up is more interesting than the event.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    retention_pattern=(
        "5-beat micro-arc — each beat 15–25 s:\n"
        "  1. HOOK — specific image or claim in the first sentence; promise the twist implicitly\n"
        "  2. STAKES — who/what/where; one sentence of context, no more\n"
        "  3. ESCALATION — 2-3 facts that make the situation stranger or harder\n"
        "  4. TURN — the line that re-frames everything ('but here's the part nobody mentions…')\n"
        "  5. PAYOFF — close on a single image or question that loops back to the hook"
    ),
    examples=(
        "EXAMPLE — Cold War mystery — 'The Soviet pilot who shot down a UFO' (≈90 s)\n"
        "  [0:00] (HOOK)   'In 1985, a Soviet pilot fired six air-to-air missiles at an object over Kazakhstan.'\n"
        "  [0:07] (STAKES) 'He was sober. He was decorated. He was on a routine intercept.'\n"
        "  [0:14] (ESC)    'Radar logged the target as 4 kilometers across. The size of a city block.'\n"
        "  [0:22] (ESC)    'The missiles connected. The object did not slow down.'\n"
        "  [0:30] (ESC)    'It accelerated to Mach 6 — and split into two.'\n"
        "  [0:40] (TURN)   'For 38 years the file said: \"Equipment malfunction.\" The pilot never agreed.'\n"
        "  [0:52] (TURN)   'He died in 2019 still saying: \"I know what I saw. And I know what saw me.\"'\n"
        "  [1:05] (PAYOFF) 'The radar tapes were declassified last year. The shape on the screen — has no name.'\n"
        "  [1:15] (PAYOFF) 'Think about that the next time someone says \"the sky is empty.\"'",
    ),
)


STANDARD_MID = FormatArchetype(
    name="STANDARD_MID",
    descriptor="Mid-length YouTube essay — clear thesis, evidence beats, retention spikes",
    narration_voice=(
        "Engaged host. Conversational but informed — like a knowledgeable friend laying out a "
        "case. Comfortable saying 'I think' when it matters."
    ),
    sentence_style=(
        "Conversational paragraphs of ~2-3 sentences. Mix declarative and interrogative."
    ),
    structural_signature="COLD OPEN → THESIS → ACT 1 (setup) → ACT 2 (evidence + turn) → PAYOFF + CTA",
    closer_style=(
        "Restate the thesis through a new lens. One-sentence takeaway. A soft CTA is OK; "
        "no generic 'don't forget to subscribe' filler."
    ),
    pacing_rules=(
        "Cold-open in ≤8 seconds with a concrete claim, image, or scene — NEVER 'in this video "
        "I'll cover…'.",
        "State the thesis explicitly once, then defend it with 2–4 evidence beats.",
        "Insert a retention hook every ~60 seconds: a contrarian sub-claim, a question, or a "
        "surprising fact.",
        "Sentences 8–22 words. Mix declarative + interrogative for cadence.",
    ),
    hook_templates=(
        "There's something strange about {topic}. Once you see it, you can't un-see it.",
        "Most people think {common_belief}. The evidence says otherwise.",
        "Everything you've been told about {topic} starts with one assumption — and that "
        "assumption is wrong.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    retention_pattern=(
        "Mid-length retention loop:\n"
        "  • Cold open: ≤8 s with a concrete scene or claim — never a topic intro\n"
        "  • Thesis: ONE sentence that the rest of the video defends\n"
        "  • Evidence beats: 2–4 in sequence; each ends with a mini-payoff\n"
        "  • ~60 s retention hooks: contrarian sub-claim, question, or surprising fact\n"
        "  • Closer: restate the thesis through a new lens + one takeaway sentence"
    ),
    examples=(
        "EXAMPLE — Sketch of an 8-minute essay — 'Why every airport looks the same' (opening + skeleton)\n"
        "  [0:00] COLD OPEN — 'There is a building where everyone behaves the same way. Shuffles the same line. "
        "Eats the same bad sandwich. Stares at the same dim screen. And we built thousands of them on purpose.'\n"
        "  [0:14] THESIS  — 'Airports are not designed for travel. They're designed to bore you — and that boredom "
        "is a control system.'\n"
        "  [0:25] ACT 1 (setup)     — define \"liminal architecture\"; explain why the FAA standardized terminals after 1972.\n"
        "  [2:00] RETENTION HOOK    — 'But here's the thing the architects won't say out loud…'\n"
        "  [3:30] ACT 2 (evidence)  — eyeline studies, queue-design papers, the duty-free dwell-time data.\n"
        "  [5:15] TURN              — 'The boring part isn't the side effect. It IS the product.'\n"
        "  [6:30] PAYOFF + CTA      — 'Next time the line drags, look up. Everything you see is doing a job.'\n"
        "Keep the body around this rhythm: 5–8 paragraphs, each ending with a beat that earns the next paragraph.",
    ),
)


CINEMATIC_3ACT = FormatArchetype(
    name="CINEMATIC_3ACT",
    descriptor="Cinematic, atmospheric documentary with 3-act structure and thematic callbacks",
    narration_voice=(
        "Measured, atmospheric, slightly reverent. Reads like a narrator over a slow-tracking "
        "shot. Restrained — the story does the work, not the adjectives."
    ),
    sentence_style=(
        "Literary. Periodic sentences welcome when they earn weight. End sections on short, "
        "weighty lines."
    ),
    structural_signature=(
        "PROLOGUE → ACT I (setup + inciting moment) → ACT II (escalation + turn) → "
        "ACT III (revelation + theme echo) → CODA"
    ),
    closer_style=(
        "A coda that returns to the opening image or rhetorical question. NO call-to-action "
        "inside the closer — leave the CTA in the description."
    ),
    pacing_rules=(
        "Open slow but loaded: a rhetorical question or a single grounding scene before the "
        "title beat. e.g. 'To understand what happened in 1947, we first need to go back to 1893…'",
        "Use repetition and thematic callbacks — a phrase, image, or question introduced early "
        "MUST return in act III.",
        "Allow 30-60 second sections to breathe. Never empty, never racing.",
        "Vary sentence length deliberately. End every act on a short, weighty line.",
        "Reveal new evidence in waves; each act earns its turn.",
    ),
    hook_templates=(
        "To understand what happened in {year}, we first need to go back to {earlier_year}…",
        "There is a recording. It is {N} seconds long. And no one — not even the people who "
        "made it — can agree on what it means.",
        "Long before {known_event}, there was {forgotten_precursor}.",
        "{Specific quiet image / line of dialogue.} That is where this story really begins.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    retention_pattern=(
        "3-act cinematic retention pattern:\n"
        "  • PROLOGUE (≤90 s) — plant a CENTRAL MOTIF (a phrase, image, question) viewers must "
        "leave the video repeating in their heads.\n"
        "  • ACT I — setup → inciting moment; introduce the protagonist or mystery, end the act "
        "on a small turn that promises the larger one.\n"
        "  • ACT II — escalation → MAJOR TURN around the 55-65% mark; the audience's assumed "
        "frame is broken here.\n"
        "  • ACT III — revelation; the answer (or the deepening of the question). Make the motif "
        "from the prologue return in a NEW context.\n"
        "  • CODA — silence, breath, motif one last time. Land on a single sentence."
    ),
    examples=(
        "EXAMPLE — Prologue of a 20-minute episode — 'The recording from Box 7' (≈80 s)\n"
        "  [0:00] (PROLOGUE — slow open)\n"
        "    'To understand what happened in 1972, we first need to go back to 1937.'\n"
        "    'A boy of nine sits in a Vermont schoolroom. He is asked to recite a poem.'\n"
        "    'He recites — flawlessly — a poem written in a language he has never spoken.'\n"
        "    'His mother weeps. His teacher writes one word in the margin: \"again.\"'\n"
        "  [0:35] (Title beat — single image, near-silence) 'This is a story about a recording. '\n"
        "    'It is seventeen seconds long. And every person who has ever listened to it — disagrees.'\n"
        "  [0:55] (Transition to Act I) 'Before the recording, there was a box. And before the box — there was a list.'\n"
        "    (motif planted: \"the list\". Returns in Act III as the closing image.)\n"
        "  [1:20] (End of prologue) 'No one knew the list existed. Then, in the winter of 1972 — someone did.'\n"
        "STRUCTURE NOTE — repeat the prologue motif (here: \"the list\") at every act boundary, and let "
        "the final shot of the coda silently echo the schoolroom image from 0:00. That is the callback.",
    ),
)


EPISODIC_CHAPTERS = FormatArchetype(
    name="EPISODIC_CHAPTERS",
    descriptor="Long episodic narrative with chapter markers, recurring motif, and recap beats",
    narration_voice=(
        "Confident long-form narrator. Willing to slow down for atmosphere; willing to speed up "
        "for tension. Treats the audience as patient and intelligent."
    ),
    sentence_style=(
        "Lean literary in the prologue and coda; leaner inside chapters. Repeat key phrases at "
        "chapter boundaries."
    ),
    structural_signature="PROLOGUE → CH1 → CH2 → CH3 → … → CODA",
    closer_style=(
        "Echo the prologue's central image or question. Optional teaser line for the next "
        "companion piece if this is part of a series."
    ),
    pacing_rules=(
        "Open with a cinematic prologue (≤90 seconds) that plants the central image / mystery / "
        "question.",
        "Each chapter is a self-contained arc (3–7 minutes) that ALSO advances the larger argument.",
        "Use brief recap beats (1–2 sentences) at chapter starts so late-joiners can re-enter.",
        "Repeat the central motif at chapter boundaries — not verbatim, but recognizably.",
        "Save the biggest reveal for ~70-85% of the total runtime, never the final 30 seconds.",
    ),
    hook_templates=CINEMATIC_3ACT.hook_templates
    + (
        "There are {N} stories here. They all begin with the same {object/name/phrase}.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    retention_pattern=(
        "Episodic chapter rhythm:\n"
        "  • PROLOGUE (≤90 s) — plant the motif; pose the central question.\n"
        "  • CHAPTER OPENS — one-sentence recap of where we left + a NEW hook for this chapter.\n"
        "  • CHAPTER BODIES — each is a self-contained 3-7 minute arc; ends on a small payoff that "
        "promises the next chapter.\n"
        "  • MAJOR REVEAL at 70-85% — never in the final 30 s.\n"
        "  • CODA — motif returns; one short final image; optional companion-piece teaser.\n"
        "Use chapter-marker style: 'I.', 'II.', 'III.' or named chapters ('I. The Box', 'II. The List')."
    ),
    examples=(
        "EXAMPLE — Chapter skeleton of a 35-minute episode — 'The Box, the List, the Recording'\n"
        "  PROLOGUE (≈80 s)    — '1937 schoolroom; the unspoken poem.' Motif planted: \"the list.\"\n"
        "  CHAPTER I (≈5 min)  — 'The Box': how it was found, who opened it, what was inside (a recording, "
        "a list, a single name). End beat: 'The first name on the list was already dead.'\n"
        "  CHAPTER II (≈6 min) — 'The Voices': who is on the recording; the linguists' fight; "
        "the language nobody could place. End beat: 'They asked: who recorded this? The answer was: yes.'\n"
        "  CHAPTER III (≈7 min) — 'The Pattern': 14 people who heard the recording before they died, "
        "and what they all said in the final week. End beat: motif repeats — \"the list, again.\"\n"
        "  MAJOR REVEAL (≈75% mark) — the boy from 1937 is on the list.\n"
        "  CHAPTER IV (≈4 min) — 'Aftermath': institutional silence; what the family was told; what is now "
        "in Box 7 today.\n"
        "  CODA (≈90 s)        — return to the schoolroom image; one final sentence — quiet, not loud.",
    ),
)


ACTION_MONTAGE = FormatArchetype(
    name="ACTION_MONTAGE",
    descriptor="Movie-style action sequence — storyboard montage with sparse voiceover",
    narration_voice=(
        "Sparse trailer narrator or no VO — when you speak, use 1–4 word punches "
        "('Hold on.', 'Now.', 'Too late.'). Most beats are silent except ambient SFX cues."
    ),
    sentence_style=(
        "Ultra-short lines only. Prefer empty narration on fast-cut beats; use narration on "
        "establishing or climax frames at most."
    ),
    structural_signature="ESTABLISH → CHASE/FIGHT BEATS (many shots) → TURN → CLIMAX → (optional) CODA",
    closer_style="One final visual beat — no 'thanks for watching', no essay conclusion.",
    pacing_rules=(
        "This is NOT a YouTube essay. Visual continuity matters more than spoken explanation.",
        "Each scene gets ONE new storyboard frame — describe a different camera angle, distance, "
        "or subject position from the previous scene.",
        "image_prompt MUST specify: subject, motion direction, environment, lighting, lens "
        "(wide / tracking / low angle / dutch tilt), and debris/motion blur when appropriate.",
        "narration_text: 0–4 words on most scenes; never more than one short sentence on any scene.",
        "Do NOT summarize the whole chase in scene 1 narration — let the images tell the story.",
        "Reference the prior shot implicitly in image_prompt ('same hero car, now airborne…').",
        "Avoid talking-head or static portrait compositions unless establishing.",
    ),
    hook_templates=(
        "Wide aerial of {location} — {hero} already at full speed.",
        "Low-angle tire smoke — engines already screaming.",
        "{Hero} rounds the bend — {threat} visible in the mirror.",
    ),
    forbidden_openers=_FORBIDDEN_GENERIC,
    retention_pattern=(
        "Action montage rhythm:\n"
        "  • ESTABLISH in ≤1 shot — already in motion when possible\n"
        "  • Alternate WIDE / MEDIUM / CLOSE / POV every 1–2 scenes\n"
        "  • Each beat advances position in space (not recap)\n"
        "  • CLIMAX = biggest readable stunt frame\n"
        "  • Optional 1-line VO on establish + climax only"
    ),
    examples=(
        "EXAMPLE — Highway chase storyboard (6 beats, ≈45 s total)\n"
        "  [1 ESTABLISH] image: aerial dusk highway, muscle car weaving traffic; narr: (silent)\n"
        "  [2 BEAT] image: side tracking shot, same car, police lights behind; narr: 'Too late.'\n"
        "  [3 BEAT] image: interior POV, speedometer pinned, mirror shows chopper; narr: (silent)\n"
        "  [4 BEAT] image: low angle, car launches off embankment; narr: (silent)\n"
        "  [5 TURN] image: mid-air slow-mo, debris and sparks; narr: (silent)\n"
        "  [6 CLIMAX] image: hero lands hard, slides through smoke toward camera; narr: 'Run.'",
    ),
)


def _base_archetype_for_duration(target_seconds: int) -> FormatArchetype:
    s = max(1, int(target_seconds))
    if s <= 60:
        return SHORTS_HOOK_DRIVEN
    if s <= 180:
        return MICRO_NARRATIVE
    if s <= 600:
        return STANDARD_MID
    if s <= 25 * 60:
        return CINEMATIC_3ACT
    return EPISODIC_CHAPTERS


def _modulate_for_video_type(
    arch: FormatArchetype,
    video_type: VideoType,
    *,
    target_seconds: int,
) -> FormatArchetype:
    """Add a small, type-specific flavor to the base duration archetype."""
    extras: tuple[str, ...] = ()
    voice_suffix = ""
    short = int(target_seconds) <= 60

    if video_type == VideoType.theory_narrative_engaging:
        if short:
            extras = (
                "Theory / mystery SHORT: one wild claim, one hidden piece of evidence, one "
                "'what if it's true?' line — NOT a survey, NOT a demography lesson.",
                "Question everything out loud ('Why would they…', 'Who gains if you believe…'). "
                "Keep the viewer curious until the cutoff.",
                "Dramatize tension; label unverified claims in ≤6 words once, never as the hook.",
            )
            voice_suffix = (
                " Alarmist curiosity — sensational hooks, plain words, ethical micro-label only at "
                "the end if needed."
            )
        else:
            extras = (
                "Lean into curiosity loops: pose a specific question at each act start and answer it "
                "1-2 beats later (never leave the loop open until the very end).",
                "Frame claims as 'reports say', 'witnesses describe', 'one theory holds' — never as "
                "settled science unless it actually is.",
            )
            voice_suffix = " Curious, but ethical: do not mislead — flag speculation as speculation."
    elif video_type == VideoType.documentary_voiceover:
        extras = (
            "Authoritative third-person. Avoid 'I' and 'we' unless quoting a participant.",
            "Quote sources implicitly: 'investigators concluded', 'records show', 'a 1962 memo "
            "states'.",
        )
        voice_suffix = " Restrained and authoritative; less emotion in the voice, more in the facts."
    elif video_type == VideoType.educational_explainer:
        extras = (
            "Define any jargon on first use in ≤6 words.",
            "One main idea per scene; resist the urge to nest concepts.",
            "Use analogies sparingly — only when they collapse a hard idea into one image.",
        )
        voice_suffix = " Patient and precise. Teacher-energy, not lecturer-energy."
    elif video_type == VideoType.commentary_opinion:
        extras = (
            "First-person allowed; state opinion clearly and own it.",
            "Mark uncertainty explicitly ('I might be wrong about this, but…') instead of "
            "hedging every line.",
            "Anticipate the strongest counter-argument before the audience can.",
        )
        voice_suffix = " Direct, opinionated, but fair. Heat without smoke."
    elif video_type == VideoType.youtube_shorts_vertical:
        extras = (
            "Vertical 9:16 framing — describe image_prompts in portrait orientation (subject "
            "centered, head-and-shoulders or full-figure vertical compositions).",
        )
    elif video_type == VideoType.youtube_long_16_9:
        extras = (
            "Standard 16:9 framing — image_prompts can be wide, cinematic, environmental.",
        )
    elif video_type == VideoType.cinematic_action_sequence:
        extras = (
            "Action montage 16:9 — every image_prompt is a sequential storyboard frame with "
            "clear motion and camera change; narration stays sparse.",
        )
        voice_suffix = " Trailer-stinger energy only — mostly silent cuts."
    elif video_type == VideoType.custom:
        extras = (
            "Custom format: if EXTRA NOTES describe a tone, structure, or constraint, those "
            "OVERRIDE the archetype defaults above.",
        )

    if not extras and not voice_suffix:
        return arch

    return replace(
        arch,
        narration_voice=(arch.narration_voice + voice_suffix).strip(),
        pacing_rules=arch.pacing_rules + extras,
    )


def format_archetype_for(video_type: VideoType, target_seconds: int) -> FormatArchetype:
    """Return the narration archetype best matching this (video_type, duration) combination."""
    if video_type == VideoType.cinematic_action_sequence:
        return _modulate_for_video_type(ACTION_MONTAGE, video_type, target_seconds=target_seconds)
    base = _base_archetype_for_duration(target_seconds)
    return _modulate_for_video_type(base, video_type, target_seconds=target_seconds)
