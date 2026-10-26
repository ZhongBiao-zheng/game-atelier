@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "PYTHONUTF8=1"
set "GIT_TERMINAL_PROMPT=0"
set "UV_HTTP_TIMEOUT=20"
rem 不继承别的项目的虚拟环境；业务运行环境统一由 bootstrap 选择。
set "VIRTUAL_ENV="
set "UV_PROJECT_ENVIRONMENT="
rem uv 找不到本机 Python 3.11+ 时要下载一份；默认源是 GitHub，国内基本下不动。
if not defined UV_PYTHON_INSTALL_MIRROR set "UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone"
cd /d "%~dp0"
title Game Atelier

echo Game Atelier
echo.
call :timer_start

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
call :timer_end "[1/6] 检查运行工具"
call :timer_start
rem uv 可能刚装好、尚未进入当前窗口 PATH；bootstrap 也需要找到它。
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
if /i "%~1"=="--skip-update" goto :update_done
rem 更新逻辑在 scripts\self_update.py（与 Mac / Linux 共用）；退出码 10 = 已更新，重跑新版启动器。
"!UV!" run --no-project python scripts\self_update.py
set "UPDATE_STATUS=!errorlevel!"
call :timer_end "[2/6] 检查更新"
if !UPDATE_STATUS! equ 10 (start "" cmd /c ""%~f0" --skip-update" & exit /b 0)

:update_done
echo.
call :timer_start
if exist "%~dp0install.ps1" (
    powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Sync
    if errorlevel 1 (set "MSG=Skill 同步失败，可稍后运行 install.ps1" & call :warn)
)
call :timer_end "[3/6] 同步 Skill"

if not exist "web\dist\index.html" (
    set "MSG=前端文件 web\dist 缺失，请双击「Windows一键修复.bat」" & call :err
    pause
    exit /b 1
)

"!UV!" run --no-project python scripts\bootstrap.py --launch
if errorlevel 1 (
    echo.
    set "MSG=启动失败。原因见上方或数据目录 .runtime\server.log" & call :err
    pause
    exit /b 1
)
echo.
echo 工坊已启动，本窗口可关闭。
timeout /t 2 >nul
exit /b 0

:warn
powershell -NoProfile -Command "Write-Host ('[警告] ' + $env:MSG) -ForegroundColor Yellow"
exit /b 0

:timer_start
set "STEP_TIME=%TIME: =0%"
exit /b 0

:timer_end
set "END_TIME=%TIME: =0%"
set /a "ELAPSED=(1%END_TIME:~0,2%-100)*360000+(1%END_TIME:~3,2%-100)*6000+(1%END_TIME:~6,2%-100)*100+(1%END_TIME:~9,2%-100)-(1%STEP_TIME:~0,2%-100)*360000-(1%STEP_TIME:~3,2%-100)*6000-(1%STEP_TIME:~6,2%-100)*100-(1%STEP_TIME:~9,2%-100)"
if !ELAPSED! lss 0 set /a ELAPSED+=8640000
set /a "WHOLE=ELAPSED/100, TENTH=(ELAPSED%%100)/10"
echo %~1 … !WHOLE!.!TENTH!s
exit /b 0

:err
powershell -NoProfile -Command "Write-Host ('[错误] ' + $env:MSG) -ForegroundColor Red"
exit /b 0
