@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "PYTHONUTF8=1"
set "GIT_TERMINAL_PROMPT=0"
set "UV_HTTP_TIMEOUT=20"
rem uv 找不到本机 Python 3.11+ 时要下载一份；默认源是 GitHub，国内基本下不动。
if not defined UV_PYTHON_INSTALL_MIRROR set "UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone"
cd /d "%~dp0"
title Game Atelier

echo Game Atelier
echo.

set "UV=uv"
where uv >nul 2>nul
if not errorlevel 1 goto :uv_ready
if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV=%USERPROFILE%\.local\bin\uv.exe"
    goto :uv_ready
)
set "MSG=未安装 uv（Python 环境管理器）" & call :warn
set "YN=Y"
set /p "YN=现在安装 uv? [Y/n]: "
if /i "!YN!"=="n" (echo 已取消。手动安装：https://docs.astral.sh/uv/ & pause & exit /b 1)
echo 安装 uv...
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV=%USERPROFILE%\.local\bin\uv.exe"
    goto :uv_ready
)
where uv >nul 2>nul
if not errorlevel 1 goto :uv_ready
set "MSG=uv 安装后仍未找到，请重开窗口再试" & call :err
pause
exit /b 1

:uv_ready
if /i "%~1"=="--skip-update" goto :update_done
rem 更新逻辑在 scripts\self_update.py（与 Mac / Linux 共用）；退出码 10 = 已更新，重跑新版启动器。
"!UV!" run --no-project python scripts\self_update.py
if !errorlevel! equ 10 (start "" cmd /c ""%~f0" --skip-update" & exit /b 0)

:update_done
echo.
if exist "%~dp0install.ps1" (
    powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Sync
    if errorlevel 1 (set "MSG=Skill 同步失败，可稍后运行 install.ps1" & call :warn)
)

if not exist ".venv\" (
    echo 首次启动，安装依赖（约 1-2 分钟）...
    "!UV!" sync
    if errorlevel 1 (set "MSG=依赖安装失败，检查网络后重试" & call :err & pause & exit /b 1)
) else (
    echo 检查依赖...
    "!UV!" sync --frozen
    if errorlevel 1 (set "MSG=依赖未能更新（离线？），沿用现有环境" & call :warn)
)
echo.

echo 停止旧实例...
"!UV!" run --no-sync python src\viewer_server\server.py stop
timeout /t 1 >nul

if not exist "web\dist\index.html" (
    set "MSG=前端文件 web\dist 缺失，请双击「Windows一键修复.bat」" & call :err
    pause
    exit /b 1
)

echo 启动工坊...
"!UV!" run --no-sync python src\viewer_server\server.py start --background
if errorlevel 1 (
    echo.
    set "MSG=启动失败。原因见上方或数据目录 .runtime\server.log" & call :err
    pause
    exit /b 1
)
echo.
echo 已启动 http://127.0.0.1:5174/ ，本窗口可关闭。
timeout /t 2 >nul
exit /b 0

:warn
powershell -NoProfile -Command "Write-Host ('[警告] ' + $env:MSG) -ForegroundColor Yellow"
exit /b 0

:err
powershell -NoProfile -Command "Write-Host ('[错误] ' + $env:MSG) -ForegroundColor Red"
exit /b 0
