@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:37841"
node server.js
pause
