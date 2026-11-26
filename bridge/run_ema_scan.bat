@echo off
REM EMA crossover scan: timeframes M1..H1, grid of stops/targets, hours of day, hold-out test.
REM Default: XAUUSD, 0.01 lot, whole day, 365 days. Options e.g.:  run_ema_scan.bat --symbol GER40 --lots 0.1
cd /d "%~dp0"
title EMA crossover scan
if not exist ".venv\Scripts\python.exe" (
  echo Run start_bridge.bat once first, so Python and the MT5 package are installed.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" ema_scan.py %*
echo.
echo Saved in the bridge\data folder (ema_scan_SYMBOL.txt).
pause
