"""Detect model format from a directory path."""
from __future__ import annotations

from pathlib import Path


def detect_format(model_path: str) -> str | None:
    p = Path(model_path)
    if not p.is_dir():
        if p.suffix.lower() == ".onnx":
            return "onnx"
        if p.suffix.lower() == ".exl2":
            return "exl2"
        return None
    if (p / "genai_config.json").is_file():
        return "onnx"
    if any(p.rglob("genai_config.json")):
        return "onnx"
    if (p / "measurement.json").is_file() or any(p.glob("*.exl2")):
        return "exl2"
    if (p / "config.json").is_file() and any(p.rglob("*.onnx")):
        return "onnx"
    if any(p.glob("*.onnx")) and (p / "genai_config.json").is_file():
        return "onnx"
    if (p / "config.json").is_file() and any(p.glob("*.exl2")):
        return "exl2"
    return None
