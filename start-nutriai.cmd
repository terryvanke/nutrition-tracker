@echo off
setlocal
cd /d "%~dp0"
title NutriAI Launcher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-nutriai.ps1"
if errorlevel 1 (
  echo.
  echo NutriAI failed to start. See the message above.
  pause
)
