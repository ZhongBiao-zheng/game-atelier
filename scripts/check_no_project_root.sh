#!/usr/bin/env bash
set -euo pipefail

# Success criterion #2 / #3 enforcement:
# - Path.cwd() must not appear in src/ or scripts/
# - PROJECT_ROOT (the legacy env var name) must not appear anywhere
violations=0
# doctor.py 的职责就是诊断 “CWD 是否=data_root” 这类环境问题，故意读 cwd 报告之，
# 是 Path.cwd() 的唯一合法用途；排除该文件，其余仍严禁隐式依赖 cwd 当数据根。
if grep -rn --include='*.py' "Path.cwd()" src/ scripts/ 2>/dev/null | grep -v '/doctor.py:'; then
  echo "ERROR: Path.cwd() found in src/ or scripts/ (doctor.py 诊断用途除外)"
  violations=1
fi
if grep -rn --include='*.py' "PROJECT_ROOT" src/ scripts/ skills/ tests/ 2>/dev/null; then
  echo "ERROR: PROJECT_ROOT env var name found — should be CHARACTER_WORKFLOW_DATA_ROOT"
  violations=1
fi
if [ $violations -ne 0 ]; then
  exit 1
fi
echo "OK: no PROJECT_ROOT / Path.cwd() leakage"
