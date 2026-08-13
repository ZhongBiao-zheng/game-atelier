#!/usr/bin/env bash
#
# game-atelier 本地安装脚本（macOS / Linux）
#
# 作用：把本源码包里的 Skill 一键链接到你机器上已安装的 AI 代理（Claude Code / Codex）。
#   - Claude Code：整插件软链到 ~/.claude/skills/game-atelier
#                  （保留 /game-atelier:* 命令命名空间，git pull 后自动是最新版）
#   - Codex      ：每个 Skill 软链到 ~/.codex/skills/game-atelier-<name>
#
# 只在检测到对应代理（存在 ~/.claude 或 ~/.codex 目录）时才安装，没装的会明确提示跳过。
#
# 用法：
#   ./install.sh            # 安装（软链）
#   ./install.sh --uninstall  # 卸载（仅移除本脚本建立的软链）
#
# 注：首次运行任意 /game-atelier:* 命令时，插件会自动在数据目录创建 .venv 并装依赖，
#     无需在这里手动 make install。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="game-atelier"
SKILLS=(character promo turnaround viewer-server)

CLAUDE_LINK="$HOME/.claude/skills/$PLUGIN_NAME"
CODEX_DIR="$HOME/.codex/skills"

installed=()
skipped=()

is_our_link() {  # $1 = path; true 当它是指向本仓库的软链
  [ -L "$1" ] && [[ "$(readlink "$1")" == "$REPO_ROOT"* ]]
}

do_link() {  # $1 = 源, $2 = 目标
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    echo "  ⚠ 目标已存在且不是软链，跳过（避免覆盖）：$2"
    return 1
  fi
  ln -sfn "$1" "$2"
}

uninstall() {
  echo "=== 卸载 game-atelier 本地软链 ==="
  if is_our_link "$CLAUDE_LINK"; then rm -f "$CLAUDE_LINK"; echo "  ✓ 移除 $CLAUDE_LINK"; fi
  for s in "${SKILLS[@]}"; do
    t="$CODEX_DIR/$PLUGIN_NAME-$s"
    if is_our_link "$t"; then rm -f "$t"; echo "  ✓ 移除 $t"; fi
  done
  echo "完成。"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

echo "=== game-atelier 本地安装（源码：${REPO_ROOT}）==="

# --- Claude Code ---
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$HOME/.claude/skills"
  if do_link "$REPO_ROOT" "$CLAUDE_LINK"; then
    installed+=("Claude Code  → $CLAUDE_LINK  (命令：/game-atelier:character 等)")
  fi
else
  skipped+=("Claude Code（未检测到 ~/.claude）")
fi

# --- Codex ---
if [ -d "$HOME/.codex" ]; then
  mkdir -p "$CODEX_DIR"
  codex_ok=1
  for s in "${SKILLS[@]}"; do
    do_link "$REPO_ROOT/skills/$s" "$CODEX_DIR/$PLUGIN_NAME-$s" || codex_ok=0
  done
  [ "$codex_ok" = 1 ] && installed+=("Codex        → $CODEX_DIR/$PLUGIN_NAME-{${SKILLS[*]// /,}}")
else
  skipped+=("Codex（未检测到 ~/.codex）")
fi

echo
echo "=== 结果 ==="
if [ "${#installed[@]}" -gt 0 ]; then
  for i in "${installed[@]}"; do echo "  ✓ 已安装：$i"; done
else
  echo "  （没有检测到任何代理，未安装任何东西）"
fi
if [ "${#skipped[@]}" -gt 0 ]; then
  for s in "${skipped[@]}"; do echo "  – 跳过：$s"; done
fi
echo
echo "重启代理后生效。首次触发 /game-atelier:* 会自动初始化数据目录与依赖。"
