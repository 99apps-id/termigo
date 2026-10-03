@echo off
setlocal
rem Launcher for the termigo agent TUI (the Go companion's `chat`).
rem Run it from the project folder you want the agent to work in:
rem   termigo-chat.bat                      start a new session here
rem   termigo-chat.bat --continue           resume the last session in this folder
rem   termigo-chat.bat --session <id>       resume a specific session
rem   termigo-chat.bat muse-spark-1.3       pick a model for this session

set "ROOT=%~dp0.."
set "BIN="
if exist "%ROOT%\dist-win\termigo-go.exe" set "BIN=%ROOT%\dist-win\termigo-go.exe"
if not defined BIN if exist "%ROOT%\src-tauri\binaries\termigo-go-win32-x64.exe" set "BIN=%ROOT%\src-tauri\binaries\termigo-go-win32-x64.exe"
if not defined BIN if exist "%ROOT%\src-tauri\binaries\termigo-go.exe" set "BIN=%ROOT%\src-tauri\binaries\termigo-go.exe"
if not defined BIN for %%G in (termigo-go.exe) do if not "%%~$PATH:G"=="" set "BIN=%%~$PATH:G"

if not defined BIN (
  echo [termigo-chat] termigo-go.exe was not found.
  echo [termigo-chat] Build it once with:  pnpm build:cli
  pause
  exit /b 1
)

echo [termigo-chat] %BIN%
echo [termigo-chat] workspace: %CD%
"%BIN%" chat %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [termigo-chat] exited with code %CODE%
  pause
)
endlocal
