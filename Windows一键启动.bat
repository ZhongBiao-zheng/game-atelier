@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "PYTHONUTF8=1"
set "GIT_TERMINAL_PROMPT=0"
set "UV_HTTP_TIMEOUT=20"
rem uv 找不到本机 Python 3.11+ 时要下载一份；默认源是 GitHub，国内基本下不动。
if not defined UV_PYTHON_INSTALL_MIRROR set "UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone"
rem main 的国内镜像（GitHub Action 每次推 main 后同步）。先拉它，失败再走 GitHub。
set "CNB_URL=https://cnb.cool/ZhongBiao-zheng/game-atelier.git"
cd /d "%~dp0"
title Game Atelier

echo Game Atelier
echo.

if /i "%~1"=="--skip-update" goto :update_done
where git >nul 2>nul
if errorlevel 1 (set "MSG=未安装 git，跳过更新" & call :warn & goto :update_done)
if not exist ".git" (set "MSG=不是 git 仓库，无法更新" & call :warn & goto :update_done)
set "CURBR=?"
set "NOWVER=?"
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURBR=%%b"
for /f "delims=" %%v in ('git rev-parse --short HEAD 2^>nul') do set "NOWVER=%%v"
echo 当前 !CURBR! @ !NOWVER!
call :fetch_updates
if errorlevel 1 (set "MSG=连不上更新源，跳过更新" & call :warn & goto :update_done)
git restore --source=HEAD --staged --worktree -- web/dist 2>nul
if errorlevel 1 git checkout HEAD -- web/dist 2>nul
git clean -qfd -- web/dist 2>nul
set "UPSTREAM="
for /f "delims=" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%u"
if not defined UPSTREAM goto :no_upstream
set "BEHIND=0"
for /f %%c in ('git rev-list --count "HEAD..@{u}" 2^>nul') do set "BEHIND=%%c"
if "!BEHIND!"=="" set "BEHIND=0"
if "!BEHIND!"=="0" (echo 已是最新 & goto :update_done)
echo 有新版本（落后 !BEHIND! 个提交）
set "UPD=1"
set /p "UPD=[1] 更新并启动  [2] 直接启动: "
if "!UPD!"=="2" goto :update_done
git merge --ff-only --quiet "@{u}"
if errorlevel 1 goto :pull_failed
echo 已更新，重新启动...
start "" cmd /c ""%~f0" --skip-update" & exit /b 0

:pull_failed
set "MSG=更新失败，以下本地改动挡住了更新" & call :err
git status --short
echo 处理后再双击；现在直接启动。
goto :update_done

:no_upstream
set "MSG=分支 !CURBR! 没有上游，无法自动更新" & call :warn
git show-ref --verify --quiet refs/remotes/origin/main
if errorlevel 1 goto :update_done
set "DIRTY="
for /f "delims=" %%d in ('git status --porcelain 2^>nul') do set "DIRTY=1"
if defined DIRTY (echo 工作区有改动，请手动 git switch main & goto :update_done)
set "SW=1"
set /p "SW=[1] 切到 main 并更新  [2] 直接启动: "
if "!SW!"=="2" goto :update_done
git switch main
if errorlevel 1 (set "MSG=切换失败，请手动 git switch main" & call :err & goto :update_done)
git merge --ff-only --quiet origin/main
if errorlevel 1 goto :pull_failed
echo 已切到 main 并更新，重新启动...
start "" cmd /c ""%~f0" --skip-update" & exit /b 0

:update_done
echo.
if exist "%~dp0install.ps1" (
    powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Sync
    if errorlevel 1 (set "MSG=Skill 同步失败，可稍后运行 install.ps1" & call :warn)
)

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

rem 镜像只有 main：拉到 origin/main，后续按上游 fast-forward 合并，与从 GitHub 拉取等价。
rem 镜像比本地 origin/main 旧（同步还没跑完）时这一步被拒，回落 GitHub。
:fetch_updates
curl.exe -s -m 6 -o nul https://cnb.cool >nul 2>nul
if errorlevel 1 goto :fetch_github
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet "%CNB_URL%" main:refs/remotes/origin/main 2>nul
if not errorlevel 1 exit /b 0
:fetch_github
curl.exe -s -m 6 -o nul https://github.com >nul 2>nul
if errorlevel 1 exit /b 1
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet 2>nul
exit /b

:warn
powershell -NoProfile -Command "Write-Host ('[警告] ' + $env:MSG) -ForegroundColor Yellow"
exit /b 0

:err
powershell -NoProfile -Command "Write-Host ('[错误] ' + $env:MSG) -ForegroundColor Red"
exit /b 0
