@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Gale Translator

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node "core\launcher.mjs"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -Command "Start-Sleep -Seconds 6"
exit /b 0
