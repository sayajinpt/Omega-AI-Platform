"""Shared PyQt6 palette and stylesheet for the desktop app."""

from __future__ import annotations

from PyQt6.QtGui import QColor, QFont, QPalette
from PyQt6.QtWidgets import QApplication

# Slate / indigo — matches modern dashboard UIs
BG = "#0b1220"
SURFACE = "#111827"
PANEL = "#1e293b"
BORDER = "#334155"
TEXT = "#f1f5f9"
MUTED = "#94a3b8"
ACCENT = "#3b82f6"
ACCENT_HOVER = "#2563eb"
DANGER = "#dc2626"
SUCCESS = "#22c55e"

APP_STYLESHEET = f"""
QMainWindow {{
    background-color: {BG};
}}
QWidget {{
    color: {TEXT};
    font-size: 13px;
}}
QLabel[class="muted"] {{
    color: {MUTED};
    font-size: 12px;
}}
QLabel[class="hero"] {{
    font-size: 22px;
    font-weight: 700;
    color: {TEXT};
}}
QLabel[class="subtitle"] {{
    font-size: 13px;
    color: {MUTED};
}}
QTabWidget::pane {{
    border: 1px solid {BORDER};
    border-radius: 10px;
    background: {SURFACE};
    top: -1px;
    padding: 4px;
}}
QTabBar::tab {{
    background: {PANEL};
    color: {MUTED};
    padding: 10px 20px;
    margin-right: 4px;
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    font-weight: 600;
}}
QTabBar::tab:selected {{
    background: {ACCENT};
    color: white;
}}
QTabBar::tab:hover:!selected {{
    background: #273549;
    color: {TEXT};
}}
QGroupBox {{
    font-weight: 600;
    border: 1px solid {BORDER};
    border-radius: 10px;
    margin-top: 14px;
    padding: 16px 12px 12px 12px;
    background: {SURFACE};
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    left: 12px;
    padding: 0 6px;
    color: {MUTED};
}}
QPushButton {{
    background-color: {PANEL};
    color: {TEXT};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 8px 16px;
    font-weight: 600;
    min-height: 20px;
}}
QPushButton:hover {{
    background-color: #273549;
    border-color: #475569;
}}
QPushButton:pressed {{
    background-color: #0f172a;
}}
QPushButton[class="primary"] {{
    background-color: {ACCENT};
    border-color: {ACCENT_HOVER};
    color: white;
}}
QPushButton[class="primary"]:hover {{
    background-color: {ACCENT_HOVER};
}}
QPushButton[class="danger"] {{
    background-color: {DANGER};
    border-color: #b91c1c;
    color: white;
}}
QLineEdit, QPlainTextEdit, QTextEdit, QSpinBox, QComboBox {{
    background-color: {BG};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 8px 10px;
    selection-background-color: {ACCENT};
}}
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus, QComboBox:focus {{
    border-color: {ACCENT};
}}
QTableWidget {{
    background-color: {BG};
    alternate-background-color: {SURFACE};
    gridline-color: {BORDER};
    border: 1px solid {BORDER};
    border-radius: 10px;
}}
QHeaderView::section {{
    background-color: {PANEL};
    color: {MUTED};
    padding: 8px;
    border: none;
    border-bottom: 1px solid {BORDER};
    font-weight: 600;
}}
QTableWidget::item:selected {{
    background-color: {ACCENT};
    color: white;
}}
QProgressBar {{
    border: 1px solid {BORDER};
    border-radius: 8px;
    text-align: center;
    background: {BG};
    height: 22px;
}}
QProgressBar::chunk {{
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 {ACCENT}, stop:1 #6366f1);
    border-radius: 6px;
}}
QStatusBar {{
    background: {SURFACE};
    color: {MUTED};
    border-top: 1px solid {BORDER};
}}
QMenuBar {{
    background: {SURFACE};
    border-bottom: 1px solid {BORDER};
    padding: 4px;
}}
QMenuBar::item:selected {{
    background: {PANEL};
    border-radius: 4px;
}}
QMenu {{
    background: {PANEL};
    border: 1px solid {BORDER};
    border-radius: 8px;
    padding: 4px;
}}
QMenu::item:selected {{
    background: {ACCENT};
}}
QDockWidget {{
    titlebar-close-icon: none;
    color: {MUTED};
    font-weight: 600;
}}
QDockWidget::title {{
    background: {SURFACE};
    padding: 6px;
    border-top: 1px solid {BORDER};
}}
QScrollBar:vertical {{
    background: {BG};
    width: 10px;
    margin: 0;
}}
QScrollBar::handle:vertical {{
    background: {BORDER};
    border-radius: 5px;
    min-height: 24px;
}}
"""


def apply_app_theme(app: QApplication) -> None:
    app.setStyle("Fusion")
    pal = QPalette()
    pal.setColor(QPalette.ColorRole.Window, QColor(BG))
    pal.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.Base, QColor(BG))
    pal.setColor(QPalette.ColorRole.AlternateBase, QColor(SURFACE))
    pal.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.Button, QColor(PANEL))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    pal.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    pal.setColor(QPalette.ColorRole.PlaceholderText, QColor(MUTED))
    app.setPalette(pal)
    app.setStyleSheet(APP_STYLESHEET)
    app.setFont(QFont("Segoe UI", 10))


def mark_primary(button) -> None:
    button.setProperty("class", "primary")
    button.style().unpolish(button)
    button.style().polish(button)


def mark_danger(button) -> None:
    button.setProperty("class", "danger")
    button.style().unpolish(button)
    button.style().polish(button)
