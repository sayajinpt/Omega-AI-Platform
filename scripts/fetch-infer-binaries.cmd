@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-infer-binaries.ps1" %*
exit /b %ERRORLEVEL%
