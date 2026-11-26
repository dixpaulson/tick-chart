@echo off
REM Tick-level verification of EMA crossover candidates (default XAUUSD, 0.01 lot, M5/M15/M30, 180 days).
REM Options e.g.:  run_ema_verify.bat --days 120 --timeframes M15 --combos 5/3/TRL,5/5/TRL
cd /d "%~dp0"
title EMA tick verification
if not exist ".venv\Scripts\python.exe" (
  echo Run start_bridge.bat once first, so Python and the MT5 package are installed.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" ema_verify.py %*
echo.
echo Saved in the bridge\data folder (ema_verify_SYMBOL.txt).
pause
