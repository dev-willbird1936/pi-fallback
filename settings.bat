@echo off
setlocal
set "TARGET_DIR=%~1"
if "%TARGET_DIR%"=="" set "TARGET_DIR=%CD%"
start "Pi fallback settings" /b node "%~dp0tools\settings-server.mjs" "%TARGET_DIR%"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:47653/"
echo Settings page: http://127.0.0.1:47653/
echo Close the server window when finished.
