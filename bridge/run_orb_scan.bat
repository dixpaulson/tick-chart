@echo off
REM Opening range breakout study: sessions, range lengths, stops, exits, volume filter, hold-out, tick verification.
REM Default XAUUSD, 0.01 lot, 365 days. Raw account: add --commission 0.07 (or your commission per trade).
cd /d "%~dp0"
title Opening range breakout study
if not exist ".venv\Scripts\python.exe" (
  echo Run start_bridge.bat once first, so Python and the MT5 package are installed.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" orb_scan.py %*
echo.
echo Saved in the bridge\data folder (orb_scan_SYMBOL.txt).
pause
