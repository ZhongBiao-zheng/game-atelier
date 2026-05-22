#!/usr/bin/env bash
set -euo pipefail

# Success criterion #2 / #3 enforcement:
# - Path.cwd() must not appear in src/ or scripts/
# - PROJECT_ROOT (the legacy env var name) must not appear anywhere
violations=0
if grep -rn --include='*.py' "Path.cwd()" src/ scripts/ 2>/dev/null; then
  echo "ERROR: Path.cwd() found in src/ or scripts/"
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
