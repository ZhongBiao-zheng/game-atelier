"""Durable submission receipts. Hold the per-request lock until exactly one worker is admitted."""
import hashlib
import json
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import HTTPException
from pydantic import Field

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock

RequestId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


@dataclass
class Submission:
    path: Path
    fingerprint: str
    state: dict

    def save(self, **state):
        atomic_write_json(self.path, {"fingerprint": self.fingerprint, **state}, durable=True)
        self.state = state


@contextmanager
def submission(scope, body):
    identifier = hashlib.sha256(json.dumps([*scope, body.request_id]).encode()).hexdigest()
    # The optimistic revision is a precondition, not part of the requested generation.
    encoded = json.dumps(body.model_dump(mode="json", exclude={"expected_revision"}), separators=(",", ":"), sort_keys=True)
    fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
    root = data_root.runtime_dir()
    path = root / "collab-submissions" / f"{identifier}.json"
    with file_lock(root / "locks" / f"collab-submission-{identifier[:2]}.lock"):
        state = json.loads(path.read_text("utf-8")) if path.exists() else {}
        if state and state.pop("fingerprint") != fingerprint:
            raise HTTPException(409, "同一次生成的提交参数已变化，请重新发起")
        yield Submission(path, fingerprint, state)
