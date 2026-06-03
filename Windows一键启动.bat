@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo    Game Atelier 一键启动
echo ============================================
echo.

REM ---- 1. 确保 uv 已安装（本项目唯一硬依赖；uv 会自动管理 Python）----
set "UV=uv"
where uv >nul 2>nul
if not errorlevel 1 goto :uv_ready
if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV=%USERPROFILE%\.local\bin\uv.exe"
    goto :uv_ready
)
echo 未检测到 uv（Python 环境管理器，本项目唯一硬依赖）。
set "YN=Y"
set /p "YN=是否现在自动安装 uv? [Y/n]: "
if /i "!YN!"=="n" (
    echo 已取消。可手动安装后重跑本脚本：https://docs.astral.sh/uv/
    pause
    exit /b 1
)
echo 正在安装 uv（需联网）...
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV=%USERPROFILE%\.local\bin\uv.exe"
    goto :uv_ready
)
where uv >nul 2>nul
if not errorlevel 1 goto :uv_ready
echo uv 安装后仍未找到。请重开终端再运行本脚本，或手动安装：https://docs.astral.sh/uv/
pause
exit /b 1

:uv_ready
echo uv: !UV!
echo.

REM ---- 2. 同步 Python 依赖（首次会下载，需联网；uv 缺 Python 会自动拉）----
echo 正在准备 Python 依赖（首次约 30-60 秒）...
"!UV!" sync
if errorlevel 1 (
    echo.
    echo 依赖同步失败。请检查网络后重试。
    pause
    exit /b 1
)
echo.

REM ---- 3. 前端：预构建的 web\dist 已随仓库分发，正常无需构建 ----
REM    仅当仓库未带 dist（异常）且本机有 Node + pnpm 时兜底构建。
if not exist "web\dist\index.html" (
    echo 未找到预构建前端 web\dist，尝试本地构建（需 Node + pnpm）...
    pushd web
    call pnpm install
    if errorlevel 1 ( set "BUILD_ERR=1" ) else (
        call pnpm build
        set "BUILD_ERR=!errorlevel!"
    )
    popd
    if not "!BUILD_ERR!"=="0" (
        echo.
        echo 前端构建失败。请确认已装 Node + pnpm，或重新 `git pull` 获取预构建 web\dist。
        pause
        exit /b 1
    )
)

REM ---- 4. 启动后端（同一进程同时服务前端），后台运行并自动开浏览器 ----
echo 启动工坊（后端 + 前端，本地 127.0.0.1）...
"!UV!" run python src\viewer_server\server.py start --background
if errorlevel 1 (
    echo.
    echo 启动失败。请看上方的错误详情判断原因，常见有：
    echo   - 网络问题导致依赖未装全：重跑本脚本
    echo   - 端口被占用：稍后重试，或先关闭旧的工坊进程
    pause
    exit /b 1
)

echo.
echo 工坊已在后台启动，浏览器应已打开 http://127.0.0.1:5174/
echo 如未自动打开，请手动访问上面的地址。本窗口可关闭。
timeout /t 3 >nul
