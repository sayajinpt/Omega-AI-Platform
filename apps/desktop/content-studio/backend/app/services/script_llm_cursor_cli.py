"""Script JSON generation via Cursor CLI ``agent -p`` (print / non-interactive mode)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from app.config import settings
from app.services.video_brief import VideoBrief

# Keep in sync with script_llm.SCRIPT_JSON_SPEC (duplicated to avoid import cycle at load time).
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


def _repo_root() -> Path:
    """``youtube_automation/`` (parent of ``backend/``)."""
    return Path(__file__).resolve().parents[3]


def _pick_latest_agent_version_dir(versions_dir: Path) -> Path | None:
    """Match the Cursor agent install layout: ``versions/YYYY.M.D-<hash>/``."""
    dirs = [p for p in versions_dir.iterdir() if p.is_dir()]
    if not dirs:
        return None

    def sort_key(p: Path) -> tuple:
        name = p.name
        try:
            date_part, _rest = name.split("-", 1)
            y, m, day = (int(x) for x in date_part.split("."))
            return (y, m, day, name)
        except (ValueError, TypeError):
            return (0, 0, 0, name)

    return max(dirs, key=sort_key)


def _node_binary_in(install_dir: Path) -> Path | None:
    for name in ("node.exe", "node"):
        candidate = install_dir / name
        if candidate.is_file():
            return candidate
    return None


def _try_direct_node_invocation(agent_exe_or_cmd: str) -> tuple[Path, Path] | None:
    """
    When ``agent.CMD`` / ``agent.cmd`` is used on Windows, ``subprocess`` runs via ``cmd.exe``,
    which enforces an ~8191-character **total** command line — a long ``-p`` prompt is truncated
    and the model returns empty ``narration_text`` / ``image_prompt`` for every scene.

    The standalone Cursor agent install ships ``versions/<ver>/node.exe`` + ``index.js`` next to
    ``agent.CMD``. Launching that Node entrypoint directly avoids ``cmd`` and raises the limit to
    the usual CreateProcess (~32k) for a single argument.
    """
    path = Path(agent_exe_or_cmd).resolve()
    parent = path.parent
    versions = parent / "versions"
    if not versions.is_dir():
        return None
    vdir = _pick_latest_agent_version_dir(versions)
    if vdir is None:
        return None
    node = _node_binary_in(vdir)
    index_js = vdir / "index.js"
    if node is None or not index_js.is_file():
        return None
    return node, index_js


def _build_agent_argv(
    exe: str,
    *,
    trust_flag: str,
    model_id: str | None,
    prompt: str,
) -> list[str]:
    """
    Build argv for ``agent -p`` headless runs.

    Flags come **before** the prompt so Commander does not treat ``--output-format`` as part of
    the free-text prompt.
    """
    opts: list[str] = []
    tf = (trust_flag or "").strip()
    if tf:
        opts.append(tf)
    opts.extend(["-p", "--output-format", "text"])
    mid = (model_id or "").strip()
    if mid and mid.lower() != "auto":
        opts.extend(["--model", mid])

    direct = _try_direct_node_invocation(exe)
    if direct:
        node, index_js = direct
        return [str(node), str(index_js), *opts, prompt]
    return [exe, *opts, prompt]


def _discover_agent_windows() -> str | None:
    """Cursor CLI installer may not add ``agent`` to PATH for existing terminals."""
    if sys.platform != "win32":
        return None
    local = os.environ.get("LOCALAPPDATA", "")
    if not local:
        return None
    root = Path(local) / "Programs" / "cursor"
    if not root.is_dir():
        return None
    for rel in ("resources/app/bin/agent.exe", "resources/app/bin/agent.cmd"):
        p = root / rel
        if p.is_file():
            return str(p)
    for pat in ("agent.exe", "agent.cmd"):
        found = next(root.rglob(pat), None)
        if found is not None and found.is_file():
            return str(found)
    return None


def resolve_cursor_cli_executable() -> str | None:
    """Return path to ``agent`` / ``agent.exe`` if found."""
    explicit = (settings.cursor_cli_path or "").strip()
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
        w = shutil.which(explicit)
        if w:
            return w
        return None
    for name in ("agent", "agent.exe"):
        w = shutil.which(name)
        if w:
            return w
    discovered = _discover_agent_windows()
    if discovered:
        return discovered
    return None


def script_llm_cursor_summary() -> str:
    """One-line diagnostics for job logs (no secrets)."""
    exe = resolve_cursor_cli_executable()
    key = (settings.cursor_api_key or os.environ.get("CURSOR_API_KEY", "") or "").strip()
    return (
        f"CURSOR_API_KEY={'set' if key else 'MISSING'}; "
        f"agent_executable={'OK ' + exe if exe else 'NOT FOUND — add Cursor CLI to PATH or set CURSOR_CLI_PATH'}"
    )


def cursor_cli_runtime_ready() -> bool:
    """True if the CLI binary exists and a Cursor API key is available."""
    if resolve_cursor_cli_executable() is None:
        return False
    key = (settings.cursor_api_key or os.environ.get("CURSOR_API_KEY", "") or "").strip()
    return bool(key)


def _build_cli_prompt(
    brief: VideoBrief,
    *,
    repair_hint: str | None,
) -> str:
    system = brief.llm_script_system_prompt()
    user = brief.llm_script_user_prompt()
    parts = [
        "You are writing a structured YouTube video script. Reply with a single JSON object only — no markdown, no code fences, no text before or after the JSON.",
        "\n--- SYSTEM / ROLE ---\n",
        system,
        "\n\n--- JSON CONTRACT ---\n",
        SCRIPT_JSON_SPEC,
        "\n\n--- PROJECT / USER BRIEF ---\n",
        user,
    ]
    if repair_hint:
        parts.extend(
            [
                "\n\n--- FIX PREVIOUS OUTPUT ---\n",
                "Your previous JSON failed automated validation. Output corrected JSON only.\n"
                "CRITICAL: For each scene with duration_seconds > 0, narration_text must contain the full spoken script "
                "(not empty) and image_prompt must describe the visuals (not empty). "
                "Preserve each scenes[i].duration_seconds exactly as listed in SCENE DURATION BUDGETS.\n\n",
                repair_hint,
                "\nReturn corrected JSON only. Preserve each scene's duration_seconds exactly as in the budget list.\n",
            ]
        )
    parts.append(
        "\n\nOutput the JSON object only. The first character of your response must be { and the last must be }."
    )
    return "".join(parts)


def call_cursor_cli_script_json(
    brief: VideoBrief,
    *,
    repair_hint: str | None = None,
) -> dict[str, Any]:
    """
    Run ``agent [--trust] -p --output-format text [--model …] <prompt>`` and parse JSON from stdout.

    Requires ``CURSOR_API_KEY`` (settings or environment). Install CLI:
    ``irm 'https://cursor.com/install?win32=true' | iex`` (Windows PowerShell).

    Uses ``cursor_cli_trust_flag`` (default ``--trust``) so non-interactive runs do not stop at the
    workspace-trust prompt for the CLI cwd.

    On Windows, if the executable is ``agent.CMD`` under a ``versions/`` install, launches the
    bundled ``node.exe …/index.js`` directly so long prompts are not truncated by ``cmd.exe``.
    """
    exe = resolve_cursor_cli_executable()
    if not exe:
        raise RuntimeError(
            "Cursor CLI not found. Install it (https://cursor.com/docs/cli/installation) "
            "so `agent` is on PATH, or set CURSOR_CLI_PATH to the agent executable."
        )
    key = (settings.cursor_api_key or os.environ.get("CURSOR_API_KEY", "") or "").strip()
    if not key:
        raise RuntimeError(
            "CURSOR_API_KEY is missing. Set it in .env or the environment so `agent` can authenticate."
        )

    prompt = _build_cli_prompt(brief, repair_hint=repair_hint)
    cwd_raw = (settings.cursor_cli_cwd or "").strip()
    cwd = Path(cwd_raw).expanduser().resolve() if cwd_raw else _repo_root()

    args = _build_agent_argv(
        exe,
        trust_flag=settings.cursor_cli_trust_flag or "",
        model_id=settings.cursor_model_id,
        prompt=prompt,
    )

    env = os.environ.copy()
    env["CURSOR_API_KEY"] = key

    timeout = max(60, int(settings.cursor_cli_timeout_seconds))
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=str(cwd),
        env=env,
        shell=False,
    )
    err_tail = (proc.stderr or "")[-4000:]
    if proc.returncode != 0:
        raise RuntimeError(
            f"Cursor CLI exited with code {proc.returncode}. stderr (tail):\n{err_tail or '(empty)'}"
        )
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError(f"Cursor CLI returned empty stdout. stderr (tail):\n{err_tail or '(empty)'}")

    from app.services.script_llm import parse_cursor_cli_stdout

    return parse_cursor_cli_stdout(out)
