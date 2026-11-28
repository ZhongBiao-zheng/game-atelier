"""Portable group snapshots. Only the current node state and its media belong to a template."""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory


from character_workflow.lib import data_root, trash
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.canvas_paste import paste_from_document
from character_workflow.lib.canvas_agent_layout import DEFAULT_SIZE
from character_workflow.lib.schemas import CanvasPoint, CanvasDocument
from character_workflow.lib.canvas_projects import (
    _now, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked,
    _resolve_canvas_media_version, canvas_project_lock_path,
)
from character_workflow.lib.file_lock import file_lock

TEMPLATE_ID = r"tpl_[0-9a-f]{24}"


def _root():
    return data_root.resolve_data_root() / "library" / "templates"


def _directory(template_id):
    if not isinstance(template_id, str) or not re.fullmatch(TEMPLATE_ID, template_id):
        raise ValueError("模板编号无效")
    return _root() / template_id


@contextmanager
def _locked(template_id):
    directory = _directory(template_id)
    with file_lock(data_root.runtime_dir() / "locks" / f"{template_id}.lock"):
        yield directory


def _read(directory):
    return json.loads(read_text_with_retry(directory / "template.json"))


def _summary(record):
    return {key: record[key] for key in
            ("id", "name", "cover", "node_count", "created_at", "updated_at", "revision")}


def list_templates():
    rows = []
    for path in _root().glob("tpl_*/template.json"):
        try:
            rows.append(_summary(_read(path.parent)))
        except FileNotFoundError:
            continue  # Deleted between enumeration and read.
    return sorted(rows, key=lambda row: (row["updated_at"], row["id"]), reverse=True)


def _name(text):
    text = text.strip()
    if not 1 <= len(text) <= 120:
        raise ValueError("模板名称须为 1 到 120 个字符")
    return text


@contextmanager
def _new_template():
    template_id = "tpl_" + secrets.token_hex(12)
    root = _root()
    root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=root) as temporary:
        directory = Path(temporary) / "snapshot"
        directory.mkdir()
        yield template_id, directory
        directory.rename(_directory(template_id))


def _snapshot_node(node, members):
    raw = node.model_dump(mode="json", exclude_none=True)
    for field in ("collab_run", "created_by", "created_by_client"):
        raw.pop(field, None)
    data = raw["data"]
    for field in ("active_run_id", "result_stack", "error"):
        data.pop(field, None)
    if (annotation := data.get("annotation")) and annotation["version_id"] != data.get("current_version_id"):
        del data["annotation"]
    for obj in [data, *data.get("layers", [])]:
        for key in ("source_node_id", "reference_node_id", "base_material_node_id", "material_node_id"):
            if obj.get(key) not in members:
                obj.pop(key, None)
    return raw


def _version_ids(node):
    data = node["data"]
    for obj in [data, data.get("annotation", {}), *data.get("layers", [])]:
        for key, value in obj.items():
            if (key == "version_id" or key.endswith("_version_id")) and isinstance(value, str):
                yield value


def _snapshot_versions(project_id, document, nodes, directory):
    media = directory / "media"
    media.mkdir()
    result = {}
    pending = {vid for node in nodes for vid in _version_ids(node)}
    while pending:
        vid = pending.pop()
        version = document.content_versions[vid]
        row = version.model_dump(mode="json", exclude_none=True,
                                 exclude={"frozen_generation", "pending_shared_original"})
        if version.kind == "text":
            row["origin"] = {"kind": "user_edit"}
        else:
            source, _ = _resolve_canvas_media_version(project_id, version)
            target = media / (version.sha256 + source.suffix.lower())
            if not target.exists():
                shutil.copyfile(source, target)
                with target.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != version.sha256:
                        raise ValueError("媒体内容与当前版本不一致")
            row["path"] = target.relative_to(directory).as_posix()
            if version.origin.kind == "user_mask":
                if version.origin.source_version_id not in result:
                    pending.add(version.origin.source_version_id)
            else:
                row["origin"] = {"kind": "upload", "upload_id": version.sha256}
        result[vid] = row
    return result


def _cover(directory, nodes, versions):
    from PIL import Image, ImageOps

    for node in reversed(nodes):
        vid = node["data"].get("current_version_id")
        if node["type"] == "image" and vid:
            with Image.open(directory / versions[vid]["path"]) as im:
                im.thumbnail((640, 480), Image.Resampling.LANCZOS)
                ImageOps.exif_transpose(im).save(directory / "media/cover.webp", "WEBP", quality=82)
            return "media/cover.webp"
    return None


def save_template(project_id, group_id, name):
    name = _name(name)
    with _new_template() as (template_id, directory):
        with file_lock(canvas_project_lock_path(project_id)):
            _recover_canvas_transactions_unlocked(project_id)
            doc = _read_canvas_document_unlocked(project_id)
            by_id = {node.id: node for node in doc.nodes}
            group = by_id.get(group_id)
            if group is None or group.type != "group":
                raise KeyError(group_id)
            members = set(group.data.member_node_ids)
            nodes = [_snapshot_node(by_id[node_id], members) for node_id in group.data.member_node_ids]
            versions = _snapshot_versions(project_id, doc, nodes, directory)
        now = _now()
        record = {
            "id": template_id, "name": name, "node_count": len(nodes),
            "cover": _cover(directory, nodes, versions),
            "created_at": now, "updated_at": now, "revision": 1,
            "payload": {"schema_version": 1, "source_project_id": project_id,
                        "nodes": [*nodes, _snapshot_node(group, members)],
                        "connections": [edge.model_dump(mode="json") for edge in doc.connections
                                        if edge.source_node_id in members and edge.target_node_id in members],
                        "content_versions": versions},
        }
        atomic_write_json(directory / "template.json", record)
    return _summary(record)


def rename_template(template_id, name):
    with _locked(template_id) as directory:
        record = _read(directory)
        record.update(name=_name(name), updated_at=_now(), revision=record["revision"] + 1)
        atomic_write_json(directory / "template.json", record)
    return _summary(record)


def duplicate_template(template_id):
    with _locked(template_id) as source, _new_template() as (new_id, directory):
        record = _read(source)
        shutil.copytree(source / "media", directory / "media")
        now = _now()
        record.update(id=new_id, name=record["name"][:117] + " 副本", created_at=now,
                      updated_at=now, revision=1)
        atomic_write_json(directory / "template.json", record)
    return _summary(record)


def delete_template(template_id):
    with _locked(template_id) as directory:
        record = _read(directory)
        return trash.move_to_trash("template", record["name"], [directory], {"template_id": template_id})


def template_cover(template_id):
    return _directory(template_id) / "media/cover.webp"



def _remap_bindings(value, ids):
    """Canvas and host plugin payloads use *_node_id(s) for bindings."""
    if isinstance(value, list):
        for item in value:
            _remap_bindings(item, ids)
    elif isinstance(value, dict):
        for field, item in value.items():
            if field.endswith("_node_id") and isinstance(item, str):
                value[field] = ids.get(item)
            elif field.endswith("_node_ids") and isinstance(item, list):
                value[field] = [ids[key] for key in item if isinstance(key, str) and key in ids]
            else:
                _remap_bindings(item, ids)


def paste_template(project_id: str, template_id: str, center: CanvasPoint, revision: int):
    with _locked(template_id) as directory:
        record = _read(directory)
        payload = record["payload"]
        nodes = payload["nodes"]
        ids = {node["id"]: f"{node['type']}-{secrets.token_hex(12)}" for node in nodes}
        group = next(node for node in nodes if node["type"] == "group")
        size = group.get("size") or {"width": DEFAULT_SIZE[0], "height": DEFAULT_SIZE[1]}
        dx = center.x - group["position"]["x"] - size["width"] / 2
        dy = center.y - group["position"]["y"] - size["height"] / 2
        group["title"] = record["name"]
        for node in nodes:
            node["id"] = ids[node["id"]]
            node["position"]["x"] += dx
            node["position"]["y"] += dy
            data = node["data"]
            _remap_bindings(data, ids)
            if draft := data.get("generation_draft"):
                draft["prompt"] = re.sub(r"@\[node:([^\]]+)\]", lambda m: (
                    f"@[node:{ids[m[1]]}]" if m[1] in ids else ""
                ), draft.get("prompt", ""))
            for layer in data.get("layers", []):
                layer["id"] = f"layer-{secrets.token_hex(12)}"
        for edge in payload["connections"]:
            edge.update(id=f"connection-{secrets.token_hex(12)}",
                        source_node_id=ids[edge["source_node_id"]], target_node_id=ids[edge["target_node_id"]])

        # Validate the clipboard in canvas coordinates. The reader supplies the bytes
        # from template ownership; this virtual uploads path is never opened.
        files = {}
        for vid, version in payload["content_versions"].items():
            if version["kind"] == "text":
                continue
            path = version["path"]
            if not re.fullmatch(r"media/[0-9a-f]{64}\.[a-z0-9]+", path):
                raise ValueError("模板媒体路径无效")
            files[vid] = directory / path
            version["path"] = "uploads/" + Path(path).name
        source = CanvasDocument(project_id=template_id, updated_at=record["updated_at"],
                                nodes=nodes, connections=payload["connections"],
                                content_versions=payload["content_versions"])
        document = paste_from_document(
            project_id=project_id, source=source, nodes=source.nodes, connections=source.connections,
            document_revision=revision, media_reader=lambda version: files[version.version_id].read_bytes(),
        )
        return group["id"], document
