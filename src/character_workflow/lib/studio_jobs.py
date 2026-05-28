"""Studio standalone job helpers. namespace='studio', 输出落到 <data_root>/studio/<job_id>/."""
from __future__ import annotations

from pathlib import Path

from character_workflow.lib.data_root import resolve_data_root


def studio_root() -> Path:
    return resolve_data_root() / "studio"


def studio_output_dir(job_id: str) -> Path:
    """Studio job 写盘路径. 与 characters/<id>/<slot>/ 物理隔离."""
    d = studio_root() / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d
