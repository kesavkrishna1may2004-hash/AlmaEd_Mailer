@echo off
title AlmaED WhatsApp sender
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and then double-click this file again.
  start https://nodejs.org
  pause
  exit /b
)
if not exist "node_modules\@supabase\supabase-js" (
  echo Installing the one package the sender needs. This happens only once...
  call npm install --omit=dev --no-audit --no-fund
)
node src\index.js
echo.
echo The sender has stopped. Your dashboard will show it as offline.
pause
