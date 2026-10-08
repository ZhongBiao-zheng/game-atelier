#!/usr/bin/env bash
# 一键启动（Mac一键启动.command / Linux一键启动.desktop 共用），与 Windows一键启动.bat 对齐。
# 不用 set -e：逐步检查、出错时停住窗口，双击时用户才看得到原因。

_self="${BASH_SOURCE[0]}"
if command -v realpath &>/dev/null; then
  _self="$(realpath "$_self")"
elif command -v readlink &>/dev/null && readlink -f "$_self" &>/dev/null; then
  _self="$(readlink -f "$_self")"
fi
SCRIPT_DIR="$(cd "$(dirname "$_self")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

export GIT_TERMINAL_PROMPT=0
export UV_HTTP_TIMEOUT=20
# uv 找不到本机 Python 3.11+ 时要下载一份；默认源是 GitHub，国内基本下不动。
export UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR:-https://registry.npmmirror.com/-/binary/python-build-standalone}"

if [ -t 1 ]; then RED=$'\033[31m'; YEL=$'\033[33m'; RST=$'\033[0m'; else RED=""; YEL=""; RST=""; fi
warn() { echo "${YEL}[警告] $*${RST}"; }
err()  { echo "${RED}[错误] $*${RST}"; }
pause_exit() {
  echo
  read -rp "按 Enter 关闭本窗口..." _ || true
  exit "${1:-1}"
}
sync_local_skills() {
  if [ -f "$PROJECT_ROOT/install.sh" ]; then
    bash "$PROJECT_ROOT/install.sh" --sync || warn "Skill 同步失败，可稍后运行 ./install.sh"
  fi
}

echo "Game Atelier"
echo

UV="$(command -v uv 2>/dev/null || true)"
if [ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
fi
if [ -z "$UV" ]; then
  warn "未安装 uv（Python 环境管理器）"
  read -rp "现在安装 uv? [Y/n]: " YN || true
  case "$YN" in
    n|N) echo "已取消。手动安装：https://docs.astral.sh/uv/"; pause_exit 1 ;;
  esac
  echo "安装 uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  if [ -x "$HOME/.local/bin/uv" ]; then
    UV="$HOME/.local/bin/uv"
  else
    UV="$(command -v uv 2>/dev/null || true)"
  fi
  if [ -z "$UV" ]; then
    err "uv 安装后仍未找到，请重开窗口再试"
    pause_exit 1
  fi
fi

if [ "${1:-}" != "--skip-update" ]; then
  # 更新逻辑在 self_update.py（与 Windows 共用）；退出码 10 = 已更新，重跑新版启动器。
  "$UV" run --no-project python scripts/self_update.py
  [ $? -eq 10 ] && exec bash "$_self" --skip-update
fi
echo

sync_local_skills

if [ ! -d ".venv" ]; then
  echo "首次启动，安装依赖（约 1-2 分钟）..."
  if ! "$UV" sync; then
    err "依赖安装失败，检查网络后重试"
    pause_exit 1
  fi
else
  echo "检查依赖..."
  "$UV" sync --frozen || warn "依赖未能更新（离线？），沿用现有环境"
fi
echo

echo "停止旧实例..."
"$UV" run --no-sync python src/viewer_server/server.py stop || true
sleep 1

if [ ! -f "web/dist/index.html" ]; then
  err "前端文件 web/dist 缺失，请双击「Mac一键修复.command」"
  pause_exit 1
fi

echo "启动工坊..."
if ! "$UV" run --no-sync python src/viewer_server/server.py start --background; then
  echo
  err "启动失败。原因见上方或数据目录 .runtime/server.log"
  pause_exit 1
fi
echo
echo "已启动 http://127.0.0.1:5174/ ，本窗口可关闭。"
sleep 2
