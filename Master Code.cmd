@echo off
rem Starts Master Code without the launcher exe.
rem
rem Same job as MasterCode.exe, minus the Node check and the tidy shutdown.
rem Kept because it works on a machine with no .NET SDK to build the exe, and
rem because it is readable: if the launcher ever misbehaves, this is what it is
rem doing underneath.

setlocal
set "MASTERCODE_ROOT=%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or is not on the PATH.
  echo   Master Code needs Node 22.6 or newer, from https://nodejs.org
  echo.
  pause
  exit /b 1
)
if not "%~1"=="" cd /d "%~1"
start "" http://127.0.0.1:4488/
node "%MASTERCODE_ROOT%packages\server\src\main.ts"
