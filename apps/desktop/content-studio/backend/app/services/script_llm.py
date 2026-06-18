"""Generate validated script JSON via Cursor CLI or an OpenAI-compatible Chat Completions API."""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from app.config import settings
from app.models import VideoProject
from app.services.cursor_script_merge import merge_validated_script, outline_content_only
from app.services.video_brief import VideoBrief


SCRIPT_JSON_SPEC = """
Respond with ONE JSON object only — no markdown fences, no prose before or after.

Schema:
{
  "title": "public-facing video title",
  "description": "YouTube description paragraph",
  "scenes": [
    {
      "duration_seconds": <integer — MUST equal the i-th value in the SCENE PLAN>,
      "narration_text": "exact words the TTS will speak — no labels, no '[scene 1]', no markdown",
      "image_prompt": "concrete shot description: subject, setting, lighting, mood, framing",
      "transition": "fade",
      "text_overlays": []
    }
  ]
}

Hard rules:
- `scenes` length MUST equal the SCENE PLAN row count. Never omit a scene; extra scenes are dropped.
- For each index i, `scenes[i].duration_seconds` MUST equal the seconds in SCENE PLAN row i+1.
- For every scene where duration_seconds > 0, both `narration_text` AND `image_prompt` must be
  non-empty (no empty strings, no whitespace-only, no 'TBD', no lorem ipsum).
- `narration_text` is exactly what the TTS engine reads. Stay inside the word budget shown in
  SCENE PLAN. No stage directions, no scene labels, no markdown.
- `image_prompt` describes ONE specific shot for that scene (who/what is on-screen, environment,
  lighting, mood, camera framing). It must reflect the narration subject for that scene, not a
  generic stock image. Avoid empty filler like 'cinematic, 8k, high quality' alone.
- `text_overlays` is an array of `{"text": "...", "placement": "lower_third"}` only when the
  brief asks for on-screen captions; otherwise leave it as `[]`.
- For SHORT-FORM videos: tell ONE specific story / claim. Do NOT survey the topic category.
"""


SCRIPT_JSON_SPEC_COMPACT = """Return ONE JSON object only (no markdown fences).

Schema: {"title":"str","description":"str","scenes":[{"duration_seconds":int,"narration_text":"str","image_prompt":"str","transition":"fade","text_overlays":[]}]}

Rules:
- scenes.length = SCENE PLAN row count; scenes[i].duration_seconds = plan row i+1 seconds.
- Non-empty narration_text and image_prompt for every scene with duration > 0.
- narration_text = exact TTS words, inside the scene word budget (~2.2 words/s).
- image_prompt = one concrete shot (subject, setting, lighting, framing); no generic filler.
- text_overlays only when the brief requests subtitles; else [].
"""


def script_json_spec(*, compact: bool = False) -> str:
    return SCRIPT_JSON_SPEC_COMPACT if compact else SCRIPT_JSON_SPEC


def compose_script_llm_prompts(brief: VideoBrief, *, compact: bool = False) -> tuple[str, str]:
    """System + user prompts for script LLM calls. compact=True for in-chat / local-model paths."""
    spec = script_json_spec(compact=compact).strip()
    system = brief.llm_script_system_prompt(compact=compact) + "\n\n" + spec
    user = brief.llm_script_user_prompt(compact=compact)
    return system, user


@dataclass(frozen=True)
class ScriptHTTPConfig:
    """Resolved Chat Completions client (OpenAI-compatible POST .../chat/completions)."""

    api_key: str
    base_url: str
    model: str
    auth: Literal["bearer", "basic"]
    orchestrator: str


def _unwrap_script_envelope(obj: dict[str, Any]) -> dict[str, Any]:
    """If the model wraps the script in ``result`` / ``output`` / etc., use the inner object."""
    if isinstance(obj.get("scenes"), list):
        return obj
    for key in ("result", "output", "data", "response", "script", "payload", "message"):
        inner = obj.get(key)
        if isinstance(inner, dict):
            if isinstance(inner.get("scenes"), list):
                return inner
            for key2 in ("script", "content", "body"):
                inner2 = inner.get(key2)
                if isinstance(inner2, dict) and isinstance(inner2.get("scenes"), list):
                    return inner2
    return obj


def _scene_has_nonempty_narration_and_image(scene: dict[str, Any]) -> bool:
    narr_keys = (
        "narration_text",
        "narrationText",
        "narration",
        "voiceover",
        "spoken_text",
        "script",
        "dialogue",
    )
    img_keys = (
        "image_prompt",
        "imagePrompt",
        "visual_prompt",
        "visualPrompt",
        "visual_description",
        "visual",
    )
    narr = ""
    for k in narr_keys:
        v = scene.get(k)
        if isinstance(v, str) and v.strip():
            narr = v.strip()
            break
    img = ""
    for k in img_keys:
        v = scene.get(k)
        if isinstance(v, str) and v.strip():
            img = v.strip()
            break
    return bool(narr and img)


def _script_candidate_score(d: dict[str, Any]) -> tuple[int, int, int]:
    """
    Prefer scripts that look complete: many scenes, filled narration+image pairs, total narration mass.

    When two candidates share the same scene count (common with duplicate JSON blobs), the CLI may emit an
    earlier placeholder with empty strings — scoring breaks ties correctly.
    """
    scenes = d.get("scenes")
    if not isinstance(scenes, list):
        return (0, 0, 0)
    pairs = sum(1 for s in scenes if isinstance(s, dict) and _scene_has_nonempty_narration_and_image(s))
    narr_mass = 0
    for s in scenes:
        if not isinstance(s, dict):
            continue
        for k in ("narration_text", "narrationText", "narration", "voiceover", "script"):
            v = s.get(k)
            if isinstance(v, str) and v.strip():
                narr_mass += len(v.strip())
                break
    return (len(scenes), pairs, narr_mass)


def _extract_json_object(text: str) -> dict[str, Any]:
    """
    Parse a JSON object from ``text``.

    Models (especially Cursor CLI) may emit **multiple** JSON values (status line, then the
    script). Taking only the first ``{`` can decode a tiny wrapper without ``scenes``, which
    makes downstream merge treat every scene as empty. We decode every object at each ``{``,
    unwrap common envelopes (``result``, …), then pick the candidate with the best ``scenes``
    payload (scene count, then filled narration/image pairs, then narration mass — breaks ties
    when two objects share the same scene count).

    Also handles a leading JSON array ``[{...}]`` (some CLIs wrap the payload).
    """
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()

    decoder = json.JSONDecoder()

    trimmed = text.lstrip()
    if trimmed.startswith("["):
        try:
            val, _end = decoder.raw_decode(trimmed)
            if isinstance(val, list) and val and isinstance(val[0], dict):
                return _unwrap_script_envelope(val[0])
        except json.JSONDecodeError:
            pass

    candidates: list[dict[str, Any]] = []
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            val, _ = decoder.raw_decode(text[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(val, dict):
            candidates.append(val)

    if not candidates:
        raise ValueError("Could not parse JSON from model response")

    with_scenes: list[dict[str, Any]] = []
    for c in candidates:
        u = _unwrap_script_envelope(c)
        if isinstance(u.get("scenes"), list):
            with_scenes.append(u)

    if with_scenes:
        return max(with_scenes, key=_script_candidate_score)

    last = _unwrap_script_envelope(candidates[-1])
    if not isinstance(last, dict):
        raise ValueError("Expected a JSON object at the root")
    return last


def parse_cursor_cli_stdout(stdout: str) -> dict[str, Any]:
    """
    Cursor CLI may print (a) pure JSON, (b) JSON envelope with a ``text`` / ``message`` field holding JSON,
    or (c) prose plus JSON. Try strict parses first, then fall back to brace scanning.
    """
    text = stdout.strip()
    if not text:
        raise ValueError("Could not parse JSON from model response")

    decoder = json.JSONDecoder()
    if text.startswith("{") or text.startswith("["):
        try:
            root = json.loads(text)
        except json.JSONDecodeError:
            root = None
        else:
            if isinstance(root, list) and root and isinstance(root[0], dict):
                root = root[0]
            if isinstance(root, dict):
                root = _unwrap_script_envelope(root)
                if isinstance(root.get("scenes"), list):
                    return root
                for key in ("text", "content", "message", "output", "result"):
                    chunk = root.get(key)
                    if isinstance(chunk, str) and "{" in chunk:
                        try:
                            return _extract_json_object(chunk)
                        except ValueError:
                            continue
                    if isinstance(chunk, dict):
                        inner = _unwrap_script_envelope(chunk)
                        if isinstance(inner.get("scenes"), list):
                            return inner
                # Single-line stream might be one JSON object but json.loads already failed above
        # NDJSON: first line is metadata, later lines hold the payload
        if root is None:
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("{") or line.startswith("["):
                    try:
                        obj, _ = decoder.raw_decode(line)
                        if isinstance(obj, dict):
                            obj = _unwrap_script_envelope(obj)
                            if isinstance(obj.get("scenes"), list):
                                return obj
                    except json.JSONDecodeError:
                        continue

    return _extract_json_object(text)


def _authorization_value(api_key: str, auth: Literal["bearer", "basic"]) -> str:
    if auth == "bearer":
        return f"Bearer {api_key}"
    raw = base64.b64encode(f"{api_key}:".encode()).decode("ascii")
    return f"Basic {raw}"


def _chat_completions(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    with httpx.Client(timeout=180.0) as client:
        r = client.post(url, headers=headers, json=body)
        r.raise_for_status()
        return r.json()


def resolve_script_http_llm_from_values(
    *,
    prefer_cursor: bool,
    cursor_api_key: str,
    openai_api_key: str,
    cursor_openai_compatible_base: str,
    openai_api_base: str,
    script_llm_model: str,
    cursor_model_id: str,
    cursor_script_llm_use_basic_auth: bool,
) -> ScriptHTTPConfig | None:
    """
    Pick Chat Completions credentials. Cursor dashboard keys are not a hosted /chat/completions
    endpoint on api.cursor.com; use CURSOR_OPENAI_COMPATIBLE_BASE with any OpenAI-compatible URL,
    or rely on OPENAI_API_KEY when the Cursor path is incomplete.
    """
    ck = (cursor_api_key or "").strip()
    ok = (openai_api_key or "").strip()
    c_base = (cursor_openai_compatible_base or "").strip().rstrip("/")
    o_base = (openai_api_base or "").strip().rstrip("/") or "https://api.openai.com/v1"
    model_o = (script_llm_model or "gpt-4o-mini").strip()
    model_c = (cursor_model_id or script_llm_model or "auto").strip() or model_o

    def openai_route(key: str, *, orchestrator: str) -> ScriptHTTPConfig:
        return ScriptHTTPConfig(
            api_key=key,
            base_url=o_base,
            model=model_o,
            auth="bearer",
            orchestrator=orchestrator,
        )

    def cursor_compat_route(key: str) -> ScriptHTTPConfig:
        auth: Literal["bearer", "basic"] = "basic" if cursor_script_llm_use_basic_auth else "bearer"
        return ScriptHTTPConfig(
            api_key=key,
            base_url=c_base,
            model=model_c,
            auth=auth,
            orchestrator="cursor_openai_compat",
        )

    if prefer_cursor:
        if ck:
            if c_base:
                return cursor_compat_route(ck)
            if ok:
                return openai_route(ok, orchestrator="cursor_preferred_openai_http_fallback")
            return None
        if ok:
            return openai_route(ok, orchestrator="openai_compat")
        return None

    if ok:
        return openai_route(ok, orchestrator="openai_compat")
    if ck and c_base:
        return cursor_compat_route(ck)
    return None


def resolve_script_http_llm() -> ScriptHTTPConfig | None:
    return resolve_script_http_llm_from_values(
        prefer_cursor=settings.prefer_cursor_for_script_llm,
        cursor_api_key=settings.cursor_api_key,
        openai_api_key=settings.openai_api_key,
        cursor_openai_compatible_base=settings.cursor_openai_compatible_base,
        openai_api_base=settings.openai_api_base,
        script_llm_model=settings.script_llm_model,
        cursor_model_id=settings.cursor_model_id,
        cursor_script_llm_use_basic_auth=settings.cursor_script_llm_use_basic_auth,
    )


def call_chat_completions_script_json(
    brief: VideoBrief,
    brief_json: dict[str, Any],
    http: ScriptHTTPConfig,
    *,
    repair_hint: str | None = None,
) -> dict[str, Any]:
    """Returns raw script dict from the LLM (before merge validation)."""
    url = f"{http.base_url.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": _authorization_value(http.api_key, http.auth),
        "Content-Type": "application/json",
    }
    sys_content, user_content = compose_script_llm_prompts(brief, compact=False)
    if repair_hint:
        user_content += (
            "\n\n---\nPREVIOUS ATTEMPT FAILED VALIDATION:\n"
            + repair_hint
            + "\nReturn corrected JSON only; preserve scene duration_seconds exactly as listed in budgets.\n"
        )
    body: dict[str, Any] = {
        "model": http.model,
        "messages": [
            {"role": "system", "content": sys_content},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.65,
        "response_format": {"type": "json_object"},
    }
    try:
        data = _chat_completions(url, headers, body)
    except httpx.HTTPStatusError:
        del body["response_format"]
        data = _chat_completions(url, headers, body)

    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"Unexpected chat completion payload: {data!r}") from exc
    return _extract_json_object(text)


def generate_script_content(
    project: VideoProject,
    brief: VideoBrief,
    brief_json: dict[str, Any],
    *,
    force_outline_stub: bool = False,
) -> dict[str, Any]:
    """
    Produce merged script content (same shape as ``outline_content_only``).

    Uses LLM when configured; falls back to outline stub only if allowed or forced.
    """
    if force_outline_stub:
        return outline_content_only(project, brief_json)

    backend = (settings.script_llm_backend or "auto").strip().lower()
    if backend not in ("auto", "openai_compat", "cursor_cli"):
        backend = "auto"

    if backend == "auto":
        from app.services.script_llm_cursor_cli import cursor_cli_runtime_ready

        backend = "cursor_cli" if cursor_cli_runtime_ready() else "openai_compat"

    if backend == "cursor_cli":
        from app.services.script_llm_cursor_cli import call_cursor_cli_script_json

        max_cli = max(2, int(settings.cursor_cli_max_attempts))
        last_err: str | None = None
        for attempt in range(max_cli):
            try:
                raw = call_cursor_cli_script_json(brief, repair_hint=last_err if attempt else None)
                return merge_validated_script(project, brief_json, raw, orchestrator="cursor_cli")
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
                if attempt == max_cli - 1:
                    raise RuntimeError(
                        f"Cursor CLI script generation failed after {max_cli} attempt(s): {exc}"
                    ) from exc
        raise RuntimeError("Cursor CLI script generation failed unexpectedly.")

    http_cfg = resolve_script_http_llm()
    if not http_cfg:
        if settings.allow_outline_script_fallback:
            return outline_content_only(project, brief_json)
        raise RuntimeError(
            "Script generation requires LLM credentials. Options: "
            "(1) Install Cursor CLI, put `agent` on PATH, set CURSOR_API_KEY, and use SCRIPT_LLM_BACKEND=auto or cursor_cli; "
            "(2) OPENAI_API_KEY + OPENAI_API_BASE for OpenAI-compatible Chat Completions; "
            "(3) CURSOR_API_KEY + CURSOR_OPENAI_COMPATIBLE_BASE (OpenAI-compatible URL ending in /v1). "
            "Or set allow_outline_script_fallback=true for empty stub scripts."
        )

    last_err: str | None = None
    for attempt in range(2):
        try:
            raw = call_chat_completions_script_json(
                brief, brief_json, http_cfg, repair_hint=last_err if attempt else None
            )
            return merge_validated_script(project, brief_json, raw, orchestrator=http_cfg.orchestrator)
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            if attempt == 1:
                raise RuntimeError(f"Script generation failed after retry: {exc}") from exc
    raise RuntimeError("Script generation failed unexpectedly.")
