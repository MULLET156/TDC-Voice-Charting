@echo off
rem Starts Voice Charting by hand (Windows). Close this window to stop it.
cd /d "%~dp0"
if not exist .env (
  echo There is no .env file yet. Copy .env.example to .env and fill it in first.
  pause
  exit /b 1
)
node server.js
pause
