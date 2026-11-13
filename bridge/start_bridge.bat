@echo off
REM Tick Chart bridge: double-click to start. First run installs what it needs.
cd /d "%~dp0"
title Tick Chart bridge
if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up Python packages. This takes a minute...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo.
    echo Python was not found. Install Python 3.12 64-bit from python.org first ^(tick "Add python.exe to PATH"^).
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
".venv\Scripts\python.exe" tickbridge.py
echo.
echo The bridge has stopped.
pause
