@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo    Game Atelier 一键更新（git pull）
echo ============================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo 未检测到 git。请先安装 Git for Windows：https://git-scm.com/download/win
    pause
    exit /b 1
)

echo 正在拉取最新代码...
git pull
if errorlevel 1 (
    echo.
    echo 更新失败。常见原因：
    echo   - 本地有未提交的改动与远端冲突：先处理本地改动再重试
    echo   - 网络问题：检查网络后重试
    pause
    exit /b 1
)

echo.
echo 更新完成。双击 "Windows一键启动.bat" 应用更新（会自动重建前端并重启）。
pause
