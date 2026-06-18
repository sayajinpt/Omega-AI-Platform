#!/usr/bin/env python3
"""Invoke Omega Python plugins (index.py). JS plugins (index.js) are no longer supported."""
import importlib.util
import json
import sys
from pathlib import Path


def load_module(entry: Path):
    spec = importlib.util.spec_from_file_location("omega_plugin", entry)
    if not spec or not spec.loader:
        raise RuntimeError(f"failed to load {entry}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "output": "usage: plugin_invoke.py <dir> <tool> [argsJson]"}))
        return

    plugin_dir = Path(sys.argv[1])
    tool_name = sys.argv[2]
    try:
        args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
    except Exception:
        print(json.dumps({"ok": False, "output": "invalid args json"}))
        return

    py_entry = plugin_dir / "index.py"
    js_entry = plugin_dir / "index.js"
    if not py_entry.is_file():
        if js_entry.is_file():
            print(
                json.dumps(
                    {
                        "ok": False,
                        "output": "JavaScript plugins removed — add index.py or use built-in native tools",
                    }
                )
            )
        else:
            print(json.dumps({"ok": False, "output": "plugin entry index.py missing"}))
        return

    try:
        mod = load_module(py_entry)
        fn = getattr(mod, tool_name, None) or getattr(mod, "default", None)
        if not callable(fn):
            print(json.dumps({"ok": False, "output": f"handler not found: {tool_name}"}))
            return
        result = fn(args)
        if isinstance(result, dict):
            ok = bool(result.get("ok"))
            output = "" if result.get("output") is None else str(result.get("output"))
        else:
            ok = True
            output = "" if result is None else str(result)
        print(json.dumps({"ok": ok, "output": output[:8000]}))
    except Exception as e:
        print(json.dumps({"ok": False, "output": str(e)[:8000]}))


if __name__ == "__main__":
    main()
