@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
REM Python UTF-8 模式：让本脚本拉起的 server / venv-python / skill CLI 全程按 UTF-8
REM 读写文件与 stdio，兜住 Windows 默认码页(cp936/cp1252)撞中文内容的编解码崩溃。
set "PYTHONUTF8=1"
cd /d "%~dp0"

echo ============================================
echo    Game Atelier 一键启动
echo ============================================
echo.

REM ---- 0. 启动前检查更新（git 仓库且联网时；更新后重启自带 --skip-update）----
if /i "%~1"=="--skip-update" goto :update_done
where git >nul 2>nul
if errorlevel 1 goto :update_done
if not exist ".git" goto :update_done
REM 私有仓库无凭证时禁止 git 弹交互输入，避免双击窗口卡死
set "GIT_TERMINAL_PROMPT=0"
git fetch --quiet 2>nul
if errorlevel 1 (
    echo 检查更新失败（可能离线），跳过更新直接启动。
    goto :update_done
)
set "BEHIND=0"
for /f %%c in ('git rev-list --count "HEAD..@{u}" 2^>nul') do set "BEHIND=%%c"
if "!BEHIND!"=="0" goto :update_done
if "!BEHIND!"=="" goto :update_done
echo 检测到新版本（落后 !BEHIND! 个提交）。
set "UPD=1"
set /p "UPD=[1] 更新后启动（默认）  [2] 直接启动: "
if "!UPD!"=="2" goto :update_done
echo 正在更新（git pull）...
git pull --ff-only
if errorlevel 1 (
    echo 更新失败（本地改动冲突或网络问题），跳过更新直接启动。
    goto :update_done
)
echo 更新完成，正在以新版本重新启动...
REM .bat 执行中被 git pull 改写会按旧字节偏移读到错乱内容；必须单行重启新脚本后立即退出。
start "" cmd /c ""%~f0" --skip-update" & exit /b 0

:update_done
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

REM ---- 2. 仅首次（无 .venv）才装依赖；装好后跳过 ----
REM    uv run 启动时本就会自动校验/补依赖（git pull 改了依赖也会自动补），
REM    所以这里的显式 sync 只为首次给个友好进度提示。
if not exist ".venv\" (
    echo 首次启动：正在准备运行环境（联网下载依赖，约 1-2 分钟，仅此一次）...
    "!UV!" sync
    if errorlevel 1 (
        echo.
        echo 依赖同步失败。请检查网络后重试。
        pause
        exit /b 1
    )
    echo 环境准备完成。
    echo.
)

REM ---- 3. 若已在运行则先停掉，保证每次双击都是"重建 + 重启"而非打开旧实例 ----
echo 停止可能在运行的旧实例...
"!UV!" run python src\viewer_server\server.py stop
timeout /t 1 >nul

REM ---- 4. 重新构建前端（有 Node + pnpm 才构建；否则用仓库自带的预构建 dist）----
where pnpm >nul 2>nul
if errorlevel 1 goto :no_pnpm

echo 重新构建前端...
set "BUILD_ERR=0"
pushd web
if not exist "node_modules\" (
    echo 首次构建：安装前端依赖...
    call pnpm install
    if errorlevel 1 set "BUILD_ERR=1"
)
if "!BUILD_ERR!"=="0" (
    call pnpm build
    if errorlevel 1 set "BUILD_ERR=1"
)
popd
if not "!BUILD_ERR!"=="0" (
    echo.
    echo 前端构建失败。请确认 Node + pnpm 正常，或 git pull 获取预构建 web\dist 后重试。
    pause
    exit /b 1
)
goto :build_done

:no_pnpm
if not exist "web\dist\index.html" (
    echo 未找到 pnpm，也没有预构建前端 web\dist。
    echo 请先 git pull 获取预构建 dist，或安装 Node + pnpm 后重试。
    pause
    exit /b 1
)
echo 未检测到 pnpm，使用仓库自带的预构建前端 web\dist。

:build_done
echo.

REM ---- 5. 启动后端（同一进程同时服务前端），后台运行并自动开浏览器 ----
echo 启动工坊（后端 + 前端，本地 127.0.0.1）...
"!UV!" run python src\viewer_server\server.py start --background
if errorlevel 1 (
    echo.
    echo 启动失败。请看上方的错误详情判断原因，常见有网络问题导致依赖未装全（重跑本脚本）
    echo 或端口被占用（稍后重试，或先关闭旧的工坊进程）。
    pause
    exit /b 1
)

echo.
echo 工坊已在后台启动，浏览器应已打开 http://127.0.0.1:5174/
echo 如未自动打开，请手动访问上面的地址。本窗口可关闭。
timeout /t 3 >nul
