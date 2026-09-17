@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH in this window.
  echo.
  echo If you already installed Node.js, this window may just have a stale
  echo PATH left over from before the install. Close this window AND any
  echo open File Explorer windows, then reopen this folder and try again.
  echo A full sign-out/sign-in or restart also fixes this reliably.
  echo.
  echo If you haven't installed it yet, get it from https://nodejs.org
  echo ^(pick the LTS version^) and re-run this file afterward.
  pause
  exit /b 1
)

echo Node found:
node -v
echo.

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed - see the errors above.
    pause
    exit /b 1
  )
)

echo Starting Valheim Server Manager...
echo Dashboard: http://localhost:4656
start "" http://localhost:4656
node server.js

echo.
echo Server stopped. Press any key to close this window.
pause >nul
