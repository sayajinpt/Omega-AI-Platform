"""Tests for Cursor CLI script backend wiring."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from app.services.script_llm_cursor_cli import (
    _build_agent_argv,
    _try_direct_node_invocation,
    cursor_cli_runtime_ready,
    resolve_cursor_cli_executable,
)


def test_cursor_cli_runtime_ready_requires_executable_and_key(monkeypatch) -> None:
    monkeypatch.delenv("CURSOR_API_KEY", raising=False)
    with patch("app.services.script_llm_cursor_cli.resolve_cursor_cli_executable", return_value=None):
        assert cursor_cli_runtime_ready() is False
    with patch("app.services.script_llm_cursor_cli.resolve_cursor_cli_executable", return_value="/bin/agent"):
        monkeypatch.setenv("CURSOR_API_KEY", "crsr_test")
        assert cursor_cli_runtime_ready() is True


def test_try_direct_node_invocation_finds_bundled_node(tmp_path) -> None:
    v = tmp_path / "versions" / "2026.05.10-abcdef"
    v.mkdir(parents=True)
    (v / "node.exe").write_bytes(b"")
    (v / "index.js").write_bytes(b"")
    cmd = tmp_path / "agent.CMD"
    cmd.write_text("@echo off\n", encoding="utf-8")
    out = _try_direct_node_invocation(str(cmd))
    assert out is not None
    node, idx = out
    assert node.name == "node.exe"
    assert idx.name == "index.js"


def test_build_agent_argv_prefers_node_launcher_when_present(tmp_path) -> None:
    v = tmp_path / "versions" / "2026.05.10-abcdef"
    v.mkdir(parents=True)
    (v / "node.exe").write_bytes(b"")
    (v / "index.js").write_bytes(b"")
    cmd = tmp_path / "agent.CMD"
    cmd.write_text("@echo off\n", encoding="utf-8")
    args = _build_agent_argv(str(cmd), trust_flag="--trust", model_id=None, prompt="hello prompt")
    assert Path(args[0]).name == "node.exe"
    assert Path(args[1]).name == "index.js"
    assert args[-1] == "hello prompt"
    assert args[-2] == "text"
    assert "--output-format" in args


def test_resolve_cursor_cli_respects_explicit_path(monkeypatch, tmp_path) -> None:
    exe = tmp_path / "my-agent.bat"
    exe.write_text("@echo off\n", encoding="utf-8")
    monkeypatch.setattr("app.config.settings.cursor_cli_path", str(exe))
    assert resolve_cursor_cli_executable() == str(exe)
