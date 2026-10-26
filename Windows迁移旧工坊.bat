@echo off
chcp 65001 >nul
setlocal
rem 临时：把旧工坊内容迁进画布。目标机器迁移确认后连同 scripts\migrate_workshop_oneclick.py 一起删除。
set "PYTHONUTF8=1"
set "GIT_TERMINAL_PROMPT=0"
set "VIRTUAL_ENV="
set "UV_PROJECT_ENVIRONMENT="
if not defined UV_PYTHON_INSTALL_MIRROR set "UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone"
cd /d "%~dp0"
title Atelier 迁移旧工坊
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 (
    echo 没有找到 uv，请先双击「Windows一键启动.bat」启动一次 Atelier。
    pause
    exit /b 1
)
uv run --no-project python scripts\migrate_workshop_oneclick.py
echo.
pause
