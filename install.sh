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
#   ./install.sh              # 安装 / 同步（软链）
#   ./install.sh --sync       # 只同步已存在的本地安装（给自动更新流程用）
#   ./install.sh --uninstall  # 卸载（仅移除本脚本建立的软链）
#
# 注：首次运行任意 /game-atelier:* 命令时，插件会自动在数据目录创建 .venv 并装依赖，
#     无需在这里手动 make install。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="game-atelier"
# 从 skills/ 现场枚举，不写死：写死的列表会随新增 skill 静默过期，
# 症状是 Codex 那边"装了但少几个命令"，而安装脚本一句提示都没有。
SKILLS=()
for _d in "$REPO_ROOT"/skills/*/; do
  # 用显式 if 而非 `[ -f ] && ...`：后者在 set -e 下条件为假时整条语句返回非零，
  # 遇到 skills/ 里任何一个没有 SKILL.md 的目录就会把安装脚本整个中断。
  if [ -f "$_d/SKILL.md" ]; then
    SKILLS+=("$(basename "$_d")")
  fi
done
if [ ${#SKILLS[@]} -eq 0 ]; then
  echo "未在 $REPO_ROOT/skills/ 下找到任何 SKILL.md，仓库不完整？" >&2
  exit 1
fi

CLAUDE_LINK="$HOME/.claude/skills/$PLUGIN_NAME"
CODEX_DIR="$HOME/.codex/skills"

installed=()
skipped=()
warnings=()
SYNC_ONLY=0

case "${1:-}" in
  "") ;;
  --sync) SYNC_ONLY=1 ;;
  --uninstall) ;;
  *) echo "未知参数：$1（支持 --sync / --uninstall）" >&2; exit 2 ;;
esac

is_our_link() {  # $1 = path; true 当它是指向本仓库的软链
  [ -L "$1" ] || return 1
  target="$(readlink "$1")"
  [ "$target" = "$REPO_ROOT" ] || [[ "$target" == "$REPO_ROOT/"* ]]
}

do_link() {  # $1 = 源, $2 = 目标
  if { [ -e "$2" ] || [ -L "$2" ]; } && ! is_our_link "$2"; then
    echo "  ⚠ 目标已存在且不属于本仓库，跳过（避免覆盖）：$2"
    return 1
  fi
  ln -sfn "$1" "$2"
}

has_codex_install() {
  for t in "$CODEX_DIR/$PLUGIN_NAME-"*; do
    is_our_link "$t" && return 0
  done
  return 1
}

prune_stale_codex_links() {
  for t in "$CODEX_DIR/$PLUGIN_NAME-"*; do
    is_our_link "$t" || continue
    s="${t##*/$PLUGIN_NAME-}"
    if [ ! -f "$REPO_ROOT/skills/$s/SKILL.md" ]; then
      rm -f "$t"
      echo "  ✓ 移除已退役 Skill 链接：$t"
    fi
  done
}

warn_duplicate_codex_skills() {
  for candidate in "$CODEX_DIR"/*; do
    [ -f "$candidate/SKILL.md" ] || continue
    candidate_name="$(sed -n 's/^name:[[:space:]]*//p' "$candidate/SKILL.md" | head -1)"
    [ -f "$REPO_ROOT/skills/$candidate_name/SKILL.md" ] || continue
    expected="$CODEX_DIR/$PLUGIN_NAME-$candidate_name"
    if [ "$candidate" != "$expected" ]; then
      warnings+=("Codex Skill '$candidate_name' 重复注册：${candidate}（保留但请检查其管理来源）")
    fi
  done
}

uninstall() {
  echo "=== 卸载 game-atelier 本地软链 ==="
  if is_our_link "$CLAUDE_LINK"; then rm -f "$CLAUDE_LINK"; echo "  ✓ 移除 $CLAUDE_LINK"; fi
  for t in "$CODEX_DIR/$PLUGIN_NAME-"*; do
    if is_our_link "$t"; then rm -f "$t"; echo "  ✓ 移除 $t"; fi
  done
  echo "完成。"
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

if [ "$SYNC_ONLY" = 1 ]; then
  echo "=== game-atelier 本地同步（源码：${REPO_ROOT}）==="
else
  echo "=== game-atelier 本地安装（源码：${REPO_ROOT}）==="
fi

# --- Claude Code ---
if [ -d "$HOME/.claude" ] && { [ "$SYNC_ONLY" = 0 ] || is_our_link "$CLAUDE_LINK"; }; then
  mkdir -p "$HOME/.claude/skills"
  if do_link "$REPO_ROOT" "$CLAUDE_LINK"; then
    installed+=("Claude Code  → $CLAUDE_LINK  (命令：/game-atelier:character 等)")
  fi
else
  if [ "$SYNC_ONLY" = 1 ]; then
    skipped+=("Claude Code（未发现本仓库的本地安装）")
  else
    skipped+=("Claude Code（未检测到 ~/.claude）")
  fi
fi

# --- Codex ---
if [ -d "$HOME/.codex" ] && { [ "$SYNC_ONLY" = 0 ] || has_codex_install; }; then
  mkdir -p "$CODEX_DIR"
  prune_stale_codex_links
  codex_ok=1
  for s in "${SKILLS[@]}"; do
    do_link "$REPO_ROOT/skills/$s" "$CODEX_DIR/$PLUGIN_NAME-$s" || codex_ok=0
  done
  warn_duplicate_codex_skills
  [ "$codex_ok" = 1 ] && installed+=("Codex        → $CODEX_DIR/$PLUGIN_NAME-{${SKILLS[*]// /,}}")
else
  if [ "$SYNC_ONLY" = 1 ]; then
    skipped+=("Codex（未发现本仓库的本地安装）")
  else
    skipped+=("Codex（未检测到 ~/.codex）")
  fi
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
if [ "${#warnings[@]}" -gt 0 ]; then
  for warning in "${warnings[@]}"; do echo "  ⚠ $warning"; done
fi
echo
echo "重启代理后生效。首次触发 /game-atelier:* 会自动初始化数据目录与依赖。"
