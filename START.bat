@echo off
title Omnex - Building Installer...

:: Auto-elevate to Administrator if not already
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator access...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
color 0B
echo.
echo  =========================================
echo   Omnex v1.0 - Installer Builder
echo  =========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Node.js not found!
  echo  Download from: https://nodejs.org
  pause
  exit /b 1
)

:: Clean previous build output entirely
if exist "dist" (
  echo  Cleaning previous build...
  rmdir /s /q dist
)

:: Install dependencies on first run
if not exist "node_modules" (
  echo  Installing build tools... (first run only, ~200MB)
  echo  Please wait...
  echo.
  call npm install
  if errorlevel 1 (
    echo  [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo  Building installer... (2-5 minutes)
echo  Please wait...
echo.

:: Disable code signing
set CSC_IDENTITY_AUTO_DISCOVERY=false
set CSC_LINK=
set WIN_CSC_LINK=

call npm run build
if errorlevel 1 (
  echo.
  echo  [ERROR] Build failed. See above for details.
  pause
  exit /b 1
)

echo.
echo  =====================================================
echo   Done! Your installer is in the dist\ folder.
echo   File: Omnex Setup 1.0.0.exe
echo.
echo   Share it with anyone - they just double-click
echo   to install. No Node.js needed on their machine.
echo  =====================================================
echo.
explorer dist
pause
