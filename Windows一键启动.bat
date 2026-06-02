@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "web\dist\index.html" (
    echo 首次启动，正在构建前端（约 10-20 秒）...
    cd web
    call pnpm build
    if errorlevel 1 (
        echo.
        echo 构建失败，请确认已安装 pnpm：npm install -g pnpm
        pause
        exit /b 1
    )
    cd ..
    echo 构建完成。
)

echo 启动工坊...
uv run python src\viewer_server\server.py start --background
if errorlevel 1 (
    echo.
    echo 启动失败，请确认已安装 uv：https://docs.astral.sh/uv/
    pause
)
