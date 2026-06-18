@echo off
REM Use the same venv as Omega Content Studio for a fair speed comparison.
set "ROOT=%~dp0"
set "PY=%ROOT%..\backend\.venv\Scripts\python.exe"
if exist "%PY%" (
  echo Using Content Studio venv: %PY%
  "%PY%" "%ROOT%qwen_tts_gui.py"
) else (
  echo WARNING: bundled venv not found — using PATH python. Install venv via Omega Settings first.
  python "%ROOT%qwen_tts_gui.py"
)
pause
