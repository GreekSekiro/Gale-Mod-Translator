@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gale Translator - Stop

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

node "core\stop.mjs"
pause
exit /b 0
