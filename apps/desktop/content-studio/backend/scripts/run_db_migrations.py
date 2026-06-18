"""
Apply Alembic migrations for Content Studio.

Do not use ``python -m alembic`` from the backend root: the ``alembic/`` migrations
folder shadows the PyPI ``alembic`` package and breaks with
"No module named alembic.__main__".
"""
from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _prepend_site_packages() -> None:
    """Use the active interpreter (Omega unified venv) — not backend/.venv (stripped in installs)."""
    import site

    for site_dir in site.getsitepackages():
        site_str = str(Path(site_dir).resolve())
        if site_str not in sys.path:
            sys.path.insert(0, site_str)


def _strip_backend_from_path() -> None:
    """``backend/alembic/`` migrations must not shadow the PyPI ``alembic`` package."""
    backend_resolved = BACKEND.resolve()
    cleaned: list[str] = []
    for entry in sys.path:
        if not entry:
            continue
        try:
            if Path(entry).resolve() == backend_resolved:
                continue
        except OSError:
            pass
        cleaned.append(entry)
    sys.path[:] = cleaned


def _require_backend_deps() -> None:
    """Alembic env.py imports ``app.config`` — need the full API venv, not alembic alone."""
    missing: list[str] = []
    for mod in ("alembic", "pydantic", "sqlalchemy"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        raise SystemExit(
            "Content Studio venv incomplete (missing: "
            + ", ".join(missing)
            + "). Finish Python setup in Omega, then restart."
        )


def main() -> None:
    import os

    os.chdir(BACKEND)
    _prepend_site_packages()
    _strip_backend_from_path()
    _require_backend_deps()
    from alembic import command
    from alembic.config import Config

    ini = BACKEND / "alembic.ini"
    if not ini.is_file():
        raise SystemExit(f"alembic.ini not found: {ini}")
    command.upgrade(Config(str(ini)), "head")


if __name__ == "__main__":
    main()
