@echo off
rem Double-click: quit the tray (a running exe can't be overwritten), build the release exe, start it again.
cd /d "%~dp0"
taskkill /im justmark.exe >nul 2>&1
rem Same RUSTFLAGS as promote.cmd, so switching between the two doesn't force a full rebuild.
set RUSTFLAGS=--remap-path-prefix=%USERPROFILE%=~
call npx tauri build --no-bundle
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)
start "" "src-tauri\target\release\justmark.exe"
