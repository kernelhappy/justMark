@echo off
rem Double-click: quit any justMark (dev or stable), build the installer, install it silently as the stable
rem copy (%LOCALAPPDATA%\justMark) and start it. Later runs update in place, keeping your shortcuts as they are.
cd /d "%~dp0"
taskkill /im justmark.exe >nul 2>&1
call npx tauri build
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)
for /f "delims=" %%f in ('dir /b /od "src-tauri\target\release\bundle\nsis\*-setup.exe"') do set setup=%%f
set upd=
if exist "%LOCALAPPDATA%\justMark\justmark.exe" set upd=/UPDATE
"src-tauri\target\release\bundle\nsis\%setup%" /S %upd% /R
