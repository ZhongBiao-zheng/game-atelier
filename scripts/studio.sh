#!/usr/bin/env bash
# 一键启动（macOS Mac一键启动.command / Linux Linux一键启动.desktop 共用）。
# 与 Windows一键启动.bat 行为对齐：确保 uv → 首次装依赖 → 停旧实例 → 重建前端 → 后台启服务+开浏览器。
#
# 刻意不使用 `set -e`：改为像 .bat 那样逐步检查 + 出错时 pause（保持窗口不闪退），
# 否则 Finder/文件管理器双击时若某步失败，窗口会瞬间关闭，用户只看到“没启动”而看不到原因。

# Resolve symlinks so this works when called from 一键启动.command / 一键启动.desktop
_self="${BASH_SOURCE[0]}"
if command -v realpath &>/dev/null; then
  _self="$(realpath "$_self")"
elif command -v readlink &>/dev/null && readlink -f "$_self" &>/dev/null; then
  _self="$(readlink -f "$_self")"
fi
SCRIPT_DIR="$(cd "$(dirname "$_self")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# 出错时停住窗口（对应 .bat 的 pause），让用户看到上面的报错原因。
pause_exit() {
  echo
  read -rp "按 Enter 关闭本窗口..." _ || true
  exit "${1:-1}"
}

echo "============================================"
echo "   Game Atelier 一键启动"
echo "============================================"
echo

# ---- 0. 启动前检查更新（git 仓库且联网时；更新后重启自带 --skip-update）----
# 这一段的每条失败路径都必须出声。旧版本有三条静默分支（没装 git / 不是 git 仓库 /
# 当前分支没有上游），跳过时一个字都不打印，用户看到的只是"一键更新没用"，无从下手。
# 私有仓库无凭证时禁止 git 弹交互输入，避免双击窗口卡死
export GIT_TERMINAL_PROMPT=0

# git pull 失败时把挡路的东西打出来，而不是笼统说一句"本地改动冲突或网络问题"。
report_pull_failure() {
  echo
  echo "[更新] 更新失败。挡住更新的本地改动如下："
  git status --short
  echo
  echo "       本地有提交还没推 - 先 git push"
  echo "       本地改动不要了   - git checkout -- 文件名"
  echo "       跳过更新，直接启动。"
}

if [ "${1:-}" = "--skip-update" ]; then
  :
elif ! command -v git &>/dev/null; then
  echo "[更新] 未检测到 git，无法自动更新。装了 git 再运行即可：https://git-scm.com/"
  echo
elif [ ! -d ".git" ]; then
  echo "[更新] 当前目录不是 git 仓库（多半是下载的 ZIP），无法自动更新。"
  echo "       请改用：git clone https://github.com/ZhongBiao-zheng/game-atelier.git"
  echo
else
  # 先把"我现在是哪一版"打出来：后面无论更新成功、失败还是跳过，用户都有参照物。
  curbr="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  echo "[更新] 当前：分支 $curbr / 版本 $(git describe --tags --always 2>/dev/null || echo '?')"

  if ! git fetch --quiet 2>/dev/null; then
    echo "[更新] 检查更新失败（网络不通或没有仓库访问权限），跳过更新直接启动。"
  else
    # web/dist 是入库的构建产物，而本脚本第 4 步每次启动都 rm -rf 后重建 —— 不先还原，
    # git pull --ff-only 会被"本地改动会被覆盖"挡住。丢弃安全：第 4 步会重新构建，
    # 没有 pnpm 时也刚好回到仓库自带的预构建版本。
    git checkout -- web/dist 2>/dev/null || true
    git clean -qfd web/dist 2>/dev/null || true

    # 上游缺失是最隐蔽的一条：@{u} 解析不出来时，旧版本 behind 落到 `|| echo 0`，
    # 与"已是最新"走同一条路径，静默跳过。必须显式判、显式说。
    if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
      echo
      echo "[更新] 无法自动更新：当前分支 $curbr 没有跟踪任何远程分支。"
      if ! git show-ref --verify --quiet refs/remotes/origin/main; then
        echo "       远程也找不到 origin/main，请检查：git remote -v"
      elif [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo "       工作区有未提交改动，不自动切换。处理完后手动执行："
        echo "           git switch main"
        echo "           git pull --ff-only"
      else
        echo "       主线分支是 main，切过去就能恢复自动更新（已推送的提交不会丢）。"
        read -rp "[1] 切到 main 并更新（默认）  [2] 保持现状直接启动: " SW || true
        if [ "$SW" != "2" ]; then
          if ! git switch main; then
            echo "       切换失败，请手动执行：git switch main"
          elif ! git pull --ff-only; then
            report_pull_failure
          else
            echo "已切到 main 并更新完成，正在以新版本重新启动..."
            exec bash "$_self" --skip-update
          fi
        fi
      fi
    else
      behind="$(git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)"
      [ -n "$behind" ] || behind=0
      if [ "$behind" = "0" ]; then
        echo "[更新] 已是最新（跟踪 $upstream）。"
      else
        echo "检测到新版本（落后 $behind 个提交）。"
        read -rp "[1] 更新后启动（默认）  [2] 直接启动: " UPD || true
        if [ "$UPD" != "2" ]; then
          echo "正在更新（git pull）..."
          if git pull --ff-only; then
            echo "更新完成，正在以新版本重新启动..."
            # 脚本执行中被 git pull 改写有读错乱风险；exec 从头执行新版本。
            exec bash "$_self" --skip-update
          else
            report_pull_failure
          fi
        fi
      fi
    fi
  fi
  echo
fi

# ---- 1. 确保 uv（本项目唯一硬依赖；GUI 双击时 PATH 常缺 ~/.local/bin，需显式兜底）----
UV="$(command -v uv 2>/dev/null || true)"
if [ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
fi
if [ -z "$UV" ]; then
  echo "未检测到 uv（Python 环境管理器，本项目唯一硬依赖）。"
  read -rp "是否现在自动安装 uv? [Y/n]: " YN || true
  case "$YN" in
    n|N)
      echo "已取消。可手动安装后重跑本脚本：https://docs.astral.sh/uv/"
      pause_exit 1
      ;;
  esac
  echo "正在安装 uv（需联网）..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  if [ -x "$HOME/.local/bin/uv" ]; then
    UV="$HOME/.local/bin/uv"
  else
    UV="$(command -v uv 2>/dev/null || true)"
  fi
  if [ -z "$UV" ]; then
    echo "uv 安装后仍未找到。请重开终端再运行本脚本，或手动安装：https://docs.astral.sh/uv/"
    pause_exit 1
  fi
fi
echo "uv: $UV"
echo

# ---- 2. 仅首次（无 .venv）才装依赖；装好后跳过 ----
#    uv run 启动时本就会自动校验/补依赖（git pull 改了依赖也会自动补），
#    所以这里的显式 sync 只为首次给个友好进度提示。
if [ ! -d ".venv" ]; then
  echo "首次启动：正在准备运行环境（联网下载依赖，约 1-2 分钟，仅此一次）..."
  if ! "$UV" sync; then
    echo
    echo "依赖同步失败。请检查网络后重试。"
    pause_exit 1
  fi
  echo "环境准备完成。"
  echo
fi

# ---- 3. 若已在运行则先停掉，保证每次双击都是“重建 + 重启”而非打开旧实例 ----
echo "停止可能在运行的旧实例..."
"$UV" run python src/viewer_server/server.py stop || true
sleep 1

# ---- 4. 重新构建前端（有 pnpm 才构建；否则用仓库自带的预构建 dist）----
if command -v pnpm &>/dev/null; then
  echo "重新构建前端..."
  build_ok=1
  (
    cd web || exit 1
    if [ ! -d "node_modules" ]; then
      echo "首次构建：安装前端依赖..."
      pnpm install || exit 1
    fi
    # 先清再构建：tailwind v4 vite 插件会把旧 dist/* 扫进 content 源，over-existing
    # 构建非幂等（CSS 会虚胖、hash 漂移，与 make build / CI clean build 不一致）。同 Makefile build 目标。
    rm -rf dist
    pnpm build || exit 1
  ) || build_ok=0
  if [ "$build_ok" != "1" ]; then
    echo
    echo "前端构建失败。请确认 Node + pnpm 正常，或 git pull 获取预构建 web/dist 后重试。"
    pause_exit 1
  fi
else
  if [ ! -f "web/dist/index.html" ]; then
    echo "未找到 pnpm，也没有预构建前端 web/dist。"
    echo "请先 git pull 获取预构建 dist，或安装 Node + pnpm 后重试。"
    pause_exit 1
  fi
  echo "未检测到 pnpm，使用仓库自带的预构建前端 web/dist。"
fi
echo

# ---- 5. 启动后端（同一进程同时服务前端），后台运行并自动开浏览器 ----
echo "启动工坊（后端 + 前端，本地 127.0.0.1）..."
if ! "$UV" run python src/viewer_server/server.py start --background; then
  echo
  echo "启动失败。常见原因：网络问题导致依赖未装全（重跑本脚本），"
  echo "或端口被占用（稍后重试，或先关闭旧的工坊进程）。"
  pause_exit 1
fi

echo
echo "工坊已在后台启动，浏览器应已打开 http://127.0.0.1:5174/"
echo "如未自动打开，请手动访问上面的地址。本窗口可关闭。"
sleep 3
