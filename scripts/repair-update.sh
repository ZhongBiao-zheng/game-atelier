#!/usr/bin/env bash
# 安全修复源码版安装：只还原可再生的 web/dist，再做 fast-forward 更新。

SELF="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

fail() {
  echo
  echo "修复失败：$1"
  exit 1
}

command -v git &>/dev/null || fail "未检测到 git，请先安装：https://git-scm.com/"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  fail "当前目录不是 git 仓库。ZIP 下载版不能自动更新，请重新下载最新版。"

echo "============================================"
echo "   Game Atelier 一键修复"
echo "============================================"
echo

dist_state="$(git status --porcelain -- web/dist 2>/dev/null)"
if [ -n "$dist_state" ] || [ ! -f web/dist/index.html ]; then
  echo "[自检] web/dist 有本地构建残留或文件缺失，正在安全还原..."
  if ! git restore --source=HEAD --staged --worktree -- web/dist 2>/dev/null; then
    git checkout HEAD -- web/dist 2>/dev/null || fail "无法从当前版本还原 web/dist。"
  fi
  # web/dist 是发布生成物；只清这里的未跟踪文件，不碰角色资产或其他本地改动。
  git clean -qfd -- web/dist || fail "无法清理 web/dist 中的构建残留。"
else
  echo "[自检] web/dist 完整且干净。"
fi

[ -f web/dist/index.html ] || fail "当前版本没有完整的 web/dist，请重新下载项目。"
[ -z "$(git status --porcelain -- web/dist 2>/dev/null)" ] || fail "web/dist 还原后仍有改动。"
echo "[自检] 前端发布文件正常。"

if [ "${1:-}" = "--repair-only" ]; then
  echo "修复完成（未联网更新）。"
  exit 0
fi

export GIT_TERMINAL_PROMPT=0
echo "[更新] 正在检查远程版本..."
git fetch --quiet || fail "无法连接远程仓库，请检查网络或仓库访问权限。"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
if ! upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)"; then
  if [ "$branch" = "main" ] && git show-ref --verify --quiet refs/remotes/origin/main; then
    git branch --set-upstream-to=origin/main main >/dev/null 2>&1 ||
      fail "无法为 main 设置 origin/main 上游。"
    upstream="origin/main"
  else
    fail "当前分支 $branch 没有上游；请切到 main 后重试。"
  fi
fi

if ! git pull --ff-only; then
  echo
  echo "以下非 dist 本地改动可能挡住了更新；修复脚本不会删除它们："
  git status --short
  fail "无法 fast-forward 更新，请先处理上面的本地改动。"
fi

[ -f web/dist/index.html ] || fail "更新完成但 web/dist/index.html 缺失，请重新下载项目。"
echo
echo "修复并更新完成（$branch → $upstream）。现在可以重新运行一键启动。"
