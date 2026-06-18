@echo off
REM Run without changing system ExecutionPolicy (works when .ps1 is blocked)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-all.ps1" %*
exit /b %ERRORLEVEL%

