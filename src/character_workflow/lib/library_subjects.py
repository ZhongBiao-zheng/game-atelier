"""Resolve editor subject tokens against a single committed library revision at submission."""
from __future__ import annotations

import re
from itertools import zip_longest
from urllib.parse import unquote

from character_workflow.lib import data_root, library
from character_workflow.lib.atomic_io import atomic_write_bytes
from character_workflow.lib.callers.openai_image import max_reference_images
from character_workflow.lib.schemas import JobParams, SubjectSnapshot

_TOKEN = re.compile(r"@\[subject:(sbj_[a-f0-9]{32}):([^\]\n]*)\]")


def display_prompt(job) -> str:
    if job.params.subject_prompt is None:
        return job.prompt
    names = {subject.id: subject.name for subject in job.params.subjects or []}
    return _TOKEN.sub(lambda match: "@" + names.get(match[1], unquote(match[2])), job.params.subject_prompt)


def expand(prompt: str, params: JobParams, model: str, *, mode: str = "image", preview=False) -> str:
    # Ignore any snapshots in the request. Only the editor tokens select local subjects.
    params.subjects = None
    params.subject_prompt = None
    matches = list(_TOKEN.finditer(prompt))
    if not matches:
        return prompt
    explicit = list(params.reference_images or [])
    # Frame slots are explicitly assigned by the editor; extra references cannot occupy them.
    frames = mode == "video" and params.frame_mode in {"first", "last", "firstlast"}
    limit = 0 if frames or mode == "audio" else max_reference_images(model)
    available = max(0, limit - len(explicit))
    rows = {}
    candidates = {}
    with library.transaction() as tx:
        for match in matches:
            key, name = match.groups()
            if key in rows:
                continue
            try:
                row = tx.get(key)
            except FileNotFoundError as error:
                raise ValueError(f"@{unquote(name)} 当前不可用") from error
            ids = row["item_ids"]
            cover = row.get("cover_item_id")
            ordered = ([cover] if cover in ids else []) + [item for item in ids if item != cover]
            rows[key] = row
            candidates[key] = [item for item in ordered if tx.get(item)["kind"] == "image"]
        selected = {key: [] for key in rows}
        images = explicit.copy()
        for round_items in zip_longest(*candidates.values()):
            for key, item in zip(rows, round_items):
                if item is None or not available:
                    continue
                try:
                    record, path = library.media(item)
                    # A later deletion of either the item or its subject cannot break the queued job.
                    target = data_root.runtime_dir() / "uploads" / "library" / record["file"]
                    if not preview and not target.exists():
                        atomic_write_bytes(target, path.read_bytes())
                except FileNotFoundError as error:
                    raise ValueError(f"@{rows[key]['name']} 当前不可用") from error
                images.append(str(target))
                selected[key].append(item)
                available -= 1
    params.reference_images = images or None
    params.subjects = [SubjectSnapshot(id=key, name=row["name"], revision=row["revision"],
                                       item_ids=selected[key]) for key, row in rows.items()]
    params.subject_prompt = prompt
    warnings = [f"@{rows[key]['name']} 只带上了 {len(selected[key])}/{len(items)} 张参考"
                for key, items in candidates.items() if len(selected[key]) < len(items)]
    if warnings:
        params.warnings = [*(params.warnings or []), *warnings]
    prefix = [f"{row['name']}：{row['description'].strip().rstrip('。')}。"
              for row in rows.values() if row["description"].strip()]
    return "\n".join([*prefix, _TOKEN.sub(lambda m: rows[m[1]]["name"], prompt)])
