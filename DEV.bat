@echo off
title Omnex Dev Mode
echo.
echo ============================================
echo   OMNEX - Developer Mode
echo ============================================
echo.
echo This runs Omnex directly without building an installer.
echo Changes to renderer files (HTML/CSS/JS) take effect on Ctrl+R.
echo Changes to main.js or preload.js need a restart.
echo.

REM Auto-elevate if not admin
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Requesting admin rights...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

REM Install deps only if node_modules is missing
if not exist "node_modules\" (
  echo Installing dependencies for the first time...
  echo This only happens once and may take a minute.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo NPM install failed. Check the errors above.
    pause
    exit /b 1
  )
)

echo.
echo Starting Omnex in dev mode...
echo.
call npx electron .

pause
