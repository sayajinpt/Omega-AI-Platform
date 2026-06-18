"""Smoke import for PyQt6 desktop (no GUI event loop)."""


def test_desktop_main_importable() -> None:
    from app.desktop.main import main

    assert callable(main)
