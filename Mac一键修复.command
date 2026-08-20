#!/usr/bin/env bash
# 在 Finder 中双击：修复 web/dist 更新死锁并拉取最新版。
ROOT="$(cd "$(dirname "$0")" && pwd)"
bash "$ROOT/scripts/repair-update.sh"
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "已修复。请重新双击「Mac一键启动.command」。"
fi
read -rp "按 Enter 关闭本窗口..." _ || true
exit "$status"
