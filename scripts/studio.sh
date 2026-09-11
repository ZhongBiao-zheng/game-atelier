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

if [ -t 1 ]; then RED=$'\033[31m'; YEL=$'\033[33m'; RST=$'\033[0m'; else RED=""; YEL=""; RST=""; fi
warn() { echo "${YEL}[警告] $*${RST}"; }
err()  { echo "${RED}[错误] $*${RST}"; }
pause_exit() {
  echo
  read -rp "按 Enter 关闭本窗口..." _ || true
  exit "${1:-1}"
}
report_pull_failure() {
  err "更新失败，以下本地改动挡住了更新："
  git status --short
  echo "处理后再运行；现在直接启动。"
}
sync_local_skills() {
  if [ -f "$PROJECT_ROOT/install.sh" ]; then
    bash "$PROJECT_ROOT/install.sh" --sync || warn "Skill 同步失败，可稍后运行 ./install.sh"
  fi
}

echo "Game Atelier"
echo

if [ "${1:-}" = "--skip-update" ]; then
  :
elif ! command -v git &>/dev/null; then
  warn "未安装 git，跳过更新"
elif [ ! -d ".git" ]; then
  warn "不是 git 仓库，无法更新"
else
  curbr="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo "当前 $curbr @ $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  if ! curl -s -m 6 -o /dev/null https://github.com 2>/dev/null; then
    warn "连不上 GitHub，跳过更新"
  elif ! git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch --quiet 2>/dev/null; then
    warn "检查更新失败，跳过更新"
  else
    if ! git restore --source=HEAD --staged --worktree -- web/dist 2>/dev/null; then
      git checkout HEAD -- web/dist 2>/dev/null || true
    fi
    git clean -qfd -- web/dist 2>/dev/null || true
    if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
      warn "分支 $curbr 没有上游，无法自动更新"
      if git show-ref --verify --quiet refs/remotes/origin/main; then
        if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
          echo "工作区有改动，请手动 git switch main"
        else
          read -rp "[1] 切到 main 并更新  [2] 直接启动: " SW || true
          if [ "$SW" != "2" ]; then
            if ! git switch main; then
              err "切换失败，请手动 git switch main"
            elif ! git pull --ff-only; then
              report_pull_failure
            else
              echo "已切到 main 并更新，重新启动..."
              exec bash "$_self" --skip-update
            fi
          fi
        fi
      fi
    else
      behind="$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
      [ -n "$behind" ] || behind=0
      if [ "$behind" = "0" ]; then
        echo "已是最新"
      else
        echo "有新版本（落后 $behind 个提交）"
        read -rp "[1] 更新并启动  [2] 直接启动: " UPD || true
        if [ "$UPD" != "2" ]; then
          if git pull --ff-only; then
            echo "已更新，重新启动..."
            exec bash "$_self" --skip-update
          else
            report_pull_failure
          fi
        fi
      fi
    fi
  fi
fi
echo

sync_local_skills

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
