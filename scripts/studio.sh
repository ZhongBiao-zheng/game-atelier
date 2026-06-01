#!/usr/bin/env bash
# One-click launcher: builds web if needed, starts viewer-server in background,
# then auto-opens the browser.
set -euo pipefail

# Resolve symlinks so this works when called from Studio.command / Studio.desktop
_self="${BASH_SOURCE[0]}"
if command -v realpath &>/dev/null; then
  _self="$(realpath "$_self")"
elif command -v readlink &>/dev/null && readlink -f "$_self" &>/dev/null; then
  _self="$(readlink -f "$_self")"
fi
SCRIPT_DIR="$(cd "$(dirname "$_self")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

export CHARACTER_WORKFLOW_DATA_ROOT="${CHARACTER_WORKFLOW_DATA_ROOT:-$PROJECT_ROOT}"

# Build web/dist if it doesn't exist yet
if [ ! -f "web/dist/index.html" ]; then
  echo "首次启动，正在构建前端（约 10-20 秒）..."
  cd web && pnpm build && cd ..
  echo "构建完成。"
fi

# --background: spawns detached uvicorn, waits ~1.5s, then opens browser
uv run python src/viewer_server/server.py start --background
