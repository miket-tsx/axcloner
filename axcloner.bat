@echo off
REM AXCLONER launcher — Windows
REM by axyers team (mikey)
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title AXCLONER by axyers team (mikey)
echo.
echo   AXCLONER  -  by axyers team (mikey)
echo.

REM --- node check ----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   node is not installed.
  echo.
  echo   Install Node 18 or newer:  https://nodejs.org/en/download
  echo   Pick the LTS Windows installer, click through, then run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo   node %NODE_MAJOR%.x is too old. Version 18.17 or newer is required.
  echo.
  echo   Download the current LTS:  https://nodejs.org/en/download
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=4080

REM --- port check ----------------------------------------------------------
set PORT_BUSY=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:"LISTENING" ^| findstr /C:":%PORT% "') do set PORT_BUSY=%%p

if defined PORT_BUSY (
  echo   port %PORT% is busy ^(pid !PORT_BUSY!^).
  echo   Another AXCLONER is probably still running.
  echo.
  set /p ANSWER=  Kill it and continue? [y/N] 
  if /i "!ANSWER!"=="y" (
    taskkill /PID !PORT_BUSY! /F >nul 2>nul
    timeout /t 1 /nobreak >nul
  ) else (
    echo.
    echo   Run on another port instead:
    echo     set PORT=4081 ^&^& axcloner.bat
    echo.
    pause
    exit /b 0
  )
)

REM --- open the browser once the server answers ----------------------------
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"

echo   node v%NODE_MAJOR%  -  port %PORT%
echo   closing this window stops the server.
echo.

node server.js

echo.
echo   server stopped.
pause
