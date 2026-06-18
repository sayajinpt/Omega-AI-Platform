@echo off
REM Omega — Windows installer: npm install, interactive llama.cpp setup (version / prebuilt / GPU), then build:win.
cd /d "%~dp0"
title Omega Build
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Build failed. See build-log.txt
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
