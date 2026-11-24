@echo off
REM EMA 9/21 crossing study on your MT5 history (GER40, 01:30-03:30 Toronto, H1/M15/M5).
REM Extra options, e.g.:  run_ema_study.bat --days 180 --target 100
cd /d "%~dp0"
title EMA crossing study
if not exist ".venv\Scripts\python.exe" (
  echo Run start_bridge.bat once first, so Python and the MT5 package are installed.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" ema_study.py %*
echo.
echo The report is also saved in the bridge\data folder (ema_study_GER40.txt and .csv).
pause
