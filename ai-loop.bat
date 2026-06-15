@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

set "URL=https://ai-auto-bot-807105550136.asia-northeast3.run.app"
set "MODE=%~1"
set "CMD=%~2"
if "%MODE%"=="" set "MODE=paper"

:: API key
set "PROJDIR=C:\Users\pch70\Projects\-"
set "KEYFILE=%PROJDIR%\.api-key"
set "FMT=%PROJDIR%\ai-loop-fmt.py"
if exist "%KEYFILE%" (
  set /p API_KEY=<"%KEYFILE%"
) else (
  echo ERROR: %KEYFILE% not found
  exit /b 1
)

if "%CMD%"=="decide" goto :DECIDE
if "%CMD%"=="" goto :SNAPSHOT
goto :COMMAND

:SNAPSHOT
echo === AI Loop Snapshot (%MODE%) ===
curl -s --max-time 30 -H "x-api-key: %API_KEY%" -H "Accept: application/json" "%URL%/api/ai-loop/snapshot?viewMode=%MODE%" -o "%TEMP%\ailoop-snap.json"
if errorlevel 1 (
  echo ERROR: API call failed
  exit /b 1
)
python "%FMT%" snap "%TEMP%\ailoop-snap.json" 2>nul
if errorlevel 1 (
  type "%TEMP%\ailoop-snap.json"
)
echo.
echo === Pending Decisions ===
curl -s --max-time 30 -H "x-api-key: %API_KEY%" -H "Accept: application/json" "%URL%/api/ai-loop/pending?viewMode=%MODE%" -o "%TEMP%\ailoop-pend.json"
python "%FMT%" pending "%TEMP%\ailoop-pend.json" 2>nul
if errorlevel 1 (
  type "%TEMP%\ailoop-pend.json"
)
goto :END

:DECIDE
echo === Pending Decisions (%MODE%) ===
curl -s --max-time 30 -H "x-api-key: %API_KEY%" -H "Accept: application/json" "%URL%/api/ai-loop/pending?viewMode=%MODE%" -o "%TEMP%\ailoop-pend.json"
python "%FMT%" pending "%TEMP%\ailoop-pend.json" 2>nul
if errorlevel 1 (
  type "%TEMP%\ailoop-pend.json"
)
goto :END

:COMMAND
echo === AI Loop Command (%MODE%) ===
if exist "%CMD%" (
  curl -s --max-time 30 -H "x-api-key: %API_KEY%" -H "Accept: application/json" -H "Content-Type: application/json" -X POST -d @"%CMD%" "%URL%/api/ai-loop/command?viewMode=%MODE%" -o "%TEMP%\ailoop-cmd.json"
) else (
  curl -s --max-time 30 -H "x-api-key: %API_KEY%" -H "Accept: application/json" -H "Content-Type: application/json" -X POST -d "%CMD%" "%URL%/api/ai-loop/command?viewMode=%MODE%" -o "%TEMP%\ailoop-cmd.json"
)
python "%FMT%" cmd "%TEMP%\ailoop-cmd.json" 2>nul
if errorlevel 1 (
  type "%TEMP%\ailoop-cmd.json"
)
goto :END

:END
endlocal
