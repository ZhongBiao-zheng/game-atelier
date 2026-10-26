"""管理操作的脱敏追加日志；调用方仅传业务摘要，绝不传凭据。"""
import json
from datetime import datetime, timezone

from character_workflow.lib import data_root
from character_workflow.lib.file_lock import file_lock


def audit_file():
    return data_root.runtime_dir() / "gateway" / "audit.jsonl"


def append(action: str, target_id: str, summary: dict, actor=None) -> None:
    row = {"time": datetime.now(timezone.utc).isoformat(),
           "actor_id": actor.id if actor else "local",
           "actor_name": actor.name if actor else "local",
           "action": action, "target_id": target_id, "summary": summary}
    path = audit_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path.with_suffix(".lock")):
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
        path.chmod(0o600)


def read(limit: int = 200) -> list[dict]:
    from collections import deque
    path = audit_file()
    with file_lock(path.with_suffix(".lock")):
        if not path.exists():
            return []
        with path.open(encoding="utf-8") as stream:
            return [json.loads(line) for line in reversed(deque(stream, maxlen=limit))]
