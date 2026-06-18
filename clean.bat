@echo off
REM Omega — full project clean (npm, dist/bin, llama source caches, build outputs).
REM Next: npm install, then build.bat
cd /d "%~dp0"
title Omega Clean
echo.
echo  Omega full clean — dist/, repo .omega/, CMake, node_modules, CS dev venv
echo  Options: --dry-run  --keep-node-modules  --keep-llama-setup
echo  Log: console only (does not remove %%USERPROFILE%%\.omega models/venvs)
echo.
node scripts/clean-fresh.mjs %*
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Clean failed (exit %ERR%^)
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
