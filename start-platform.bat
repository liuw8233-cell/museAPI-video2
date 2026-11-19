@echo off
title MuseAPI-Video Platform (reuse upstream 18610)
cd /d "%~dp0server"

echo ==========================================
echo   MuseAPI-Video - platform only
echo ==========================================
echo.
echo   Reuses the muse2api gateway on 18610.
echo   Make sure it is running: D:\muse-canvas\muse2api\start-muse.bat
echo.

curl -s -o nul -m 3 http://127.0.0.1:18610/healthz
if errorlevel 1 (
  echo [WARN] Upstream 18610 not responding - generation will fail.
  echo        Start start-muse.bat first, then rerun this.
  echo.
)

if not exist "node_modules\" (
  echo [1/1] Installing server dependencies...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
)

if not exist ".env" (
  echo [WARN] server\.env missing - copy from .env.example and set MUSE_KEY.
  pause
  exit /b 1
)

echo Platform: http://127.0.0.1:8787
echo Keep this window OPEN.
echo.

start "" http://127.0.0.1:8787
node src\index.js

echo.
echo Platform exited.
pause
