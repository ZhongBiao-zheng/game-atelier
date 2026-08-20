@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo    Game Atelier 一键修复
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 goto :no_git
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 goto :not_repo

set "DIST_DIRTY="
for /f "delims=" %%d in ('git status --porcelain -- web/dist 2^>nul') do set "DIST_DIRTY=1"
if defined DIST_DIRTY goto :repair_dist
if not exist "web\dist\index.html" goto :repair_dist
echo [自检] web\dist 完整且干净。
goto :dist_ready

:repair_dist
echo [自检] web\dist 有本地构建残留或文件缺失，正在安全还原...
git restore --source=HEAD --staged --worktree -- web/dist 2>nul
if errorlevel 1 git checkout HEAD -- web/dist 2>nul
if errorlevel 1 goto :dist_failed
REM web\dist 是发布生成物；只清这里的未跟踪文件，不碰角色资产或其他本地改动。
git clean -qfd -- web/dist
if errorlevel 1 goto :dist_failed

:dist_ready
if not exist "web\dist\index.html" goto :dist_failed
set "DIST_DIRTY="
for /f "delims=" %%d in ('git status --porcelain -- web/dist 2^>nul') do set "DIST_DIRTY=1"
if defined DIST_DIRTY goto :dist_failed
echo [自检] 前端发布文件正常。

if /i "%~1"=="--repair-only" goto :success_local
set "GIT_TERMINAL_PROMPT=0"
echo [更新] 正在检查远程版本...
git fetch --quiet
if errorlevel 1 goto :fetch_failed

set "CURBR=?"
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURBR=%%b"
set "UPSTREAM="
for /f "delims=" %%u in ('git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2^>nul') do set "UPSTREAM=%%u"
if defined UPSTREAM goto :pull
if /i not "!CURBR!"=="main" goto :no_upstream
git show-ref --verify --quiet refs/remotes/origin/main
if errorlevel 1 goto :no_upstream
git branch --set-upstream-to=origin/main main >nul 2>nul
if errorlevel 1 goto :no_upstream
set "UPSTREAM=origin/main"

:pull
git pull --ff-only
if errorlevel 1 goto :pull_failed
if not exist "web\dist\index.html" goto :dist_failed
echo.
echo 修复并更新完成（!CURBR! → !UPSTREAM!）。现在可以重新运行一键启动。
goto :success

:pull_failed
echo.
echo 以下非 dist 本地改动可能挡住了更新；修复脚本不会删除它们：
git status --short
echo.
echo 修复失败：无法 fast-forward 更新，请先处理上面的本地改动。
goto :failed

:no_upstream
echo 修复失败：当前分支 !CURBR! 没有上游；请切到 main 后重试。
goto :failed

:fetch_failed
echo 修复失败：无法连接远程仓库，请检查网络或仓库访问权限。
goto :failed

:dist_failed
echo 修复失败：无法还原完整的 web\dist，请重新下载最新版项目。
goto :failed

:no_git
echo 修复失败：未检测到 git，请先安装：https://git-scm.com/
goto :failed

:not_repo
echo 修复失败：当前目录不是 git 仓库。ZIP 下载版不能自动更新，请重新下载最新版。
goto :failed

:success_local
echo 修复完成（未联网更新）。

:success
echo.
pause
exit /b 0

:failed
echo.
pause
exit /b 1
