@echo off
title EvEJS Launcher - Preview
cd /d "%~dp0"

echo.
echo   ============================================================
echo     EvEJS 启动器 · 一键预览（自动编译并启动）
echo   ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo   [INFO] 依赖未安装，正在 npm install（首次较慢）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [ERROR] npm install 失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo   [INFO] 正在编译并启动，启动器窗口弹出后可最小化本窗口...
echo.
call npm start
if errorlevel 1 (
  echo.
  echo   [ERROR] 启动失败，请查看上方错误信息
  pause
  exit /b 1
)
