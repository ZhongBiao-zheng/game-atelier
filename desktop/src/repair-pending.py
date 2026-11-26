"""Recover the launcher's commit pointer under the in-app executor's existing lock."""
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
source, transaction = sys.argv[2:]
app = root / "versions" / source / "app"
sys.path[:0] = [str(app / "scripts"), str(app / "src")]

from bootstrap import APP_NAME, bundle_version, resolve_data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.file_lock import try_file_lock

data_root = resolve_data_root() or Path.home() / APP_NAME
with try_file_lock(data_root / ".runtime/update.lock") as acquired:
    if not acquired:
        sys.exit("更新进行中，请稍后重试")
    try:
        last_good = (root / "last-good").read_text(encoding="utf-8").strip()
    except (FileNotFoundError, UnicodeError):
        last_good = ""
    if bundle_version(root, last_good) is None:
        pending = json.loads((root / "updates/pending.json").read_text(encoding="utf-8"))
        if pending.get("update_id") != transaction or pending.get("from") != source:
            sys.exit("更新事务已变化，请重试")
        atomic_write_text(root / "last-good", source + "\n")
