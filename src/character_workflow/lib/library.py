"""Personal library. Container membership and item metadata are published together."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from io import BytesIO

from character_workflow.lib import data_root, slug, trash
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json, read_text_with_retry
from character_workflow.lib.file_lock import file_lock

_PREFIXES = {"itm": "items", "fld": "folders", "sbj": "subjects"}
_ID = re.compile(r"(itm|fld|sbj)_[a-f0-9]{32}")
FAVORITES = "favorites"


def root():
    return data_root.resolve_data_root() / "library"


def _path(key):
    if key == FAVORITES:
        return root() / "folders/favorites.json"
    match = _ID.fullmatch(key)
    if not match:
        raise ValueError("无效的素材库标识")
    base = root() / _PREFIXES[match[1]]
    return base / key / "item.json" if match[1] == "itm" else base / f"{key}.json"


def _new(prefix):
    return f"{prefix}_{uuid.uuid4().hex}"


def _read(key):
    return json.loads(read_text_with_retry(_path(key)))


def _all(kind):
    return [json.loads(read_text_with_retry(path)) for path in sorted((root() / kind).glob("*.json"))]


def _now():
    return datetime.now(timezone.utc).isoformat()


def _lock(key):
    return file_lock(data_root.runtime_dir() / "locks/library" / f"{key}.lock")


def _journal():
    return data_root.runtime_dir() / "library-transaction.json"


def _publish(rows):
    for row in rows:
        with _lock(row["id"]):
            atomic_write_json(_path(row["id"]), row)
    _journal().unlink()


def _pending_items():
    return data_root.runtime_dir() / "library-new-items.log"


def _recover_items():
    pending = _pending_items()
    if not pending.exists():
        return
    for key in pending.read_text().splitlines():
        if not _ID.fullmatch(key) or not key.startswith("itm_"):
            continue
        path = _path(key)
        if not path.exists() and path.parent.is_dir():
            shutil.rmtree(path.parent)
    pending.unlink()


class _Changes:
    """Stage records in memory. Readers recover a partially published transaction before use."""

    def __init__(self):
        self.rows = {}
        self.created_dirs = []

    def get(self, key):
        return self.rows[key] if key in self.rows else _read(key)

    def put(self, row):
        now = _now()
        next_row = {**row, "updated_at": now, "revision": row.get("revision", 0) + 1}
        next_row.setdefault("created_at", now)
        self.rows[row["id"]] = next_row
        return next_row

    def commit(self):
        if self.rows:
            rows = list(self.rows.values())
            atomic_write_json(_journal(), rows, durable=True)
            _publish(rows)


@contextmanager
def transaction():
    # The outer lock serializes tree membership and unique handles across multiple objects.
    with _lock("tree"):
        if _journal().exists():
            _publish(json.loads(read_text_with_retry(_journal())))
        _recover_items()
        change = _Changes()
        if not _path(FAVORITES).exists():
            change.put(dict(id=FAVORITES, name="收藏", system="favorites", parent_id=None, item_ids=[]))
            change.commit()
            change.rows.clear()
        try:
            yield change
            change.commit()
            if change.created_dirs:
                _pending_items().unlink(missing_ok=True)
        except BaseException:
            if not _journal().exists():
                for directory in change.created_dirs:
                    shutil.rmtree(directory, ignore_errors=True)
            raise


def catalog():
    with transaction():
        folders = _all("folders")
        subjects = _all("subjects")
        items = {key: _read(key) for owner in folders + subjects for key in owner["item_ids"]}
        return dict(folders=folders, subjects=subjects, items=items)


def _title(value):
    name = value.strip()
    if not name or len(name) > 160:
        raise ValueError("名称请输入 1 至 160 个字符")
    return name


def _parent(tx, key):
    if key is not None and (not key.startswith("fld_") or tx.get(key).get("parent_id")):
        raise ValueError("文件夹最多两层，不能移到这里")


def _container(tx, key):
    row = tx.get(key)
    if "item_ids" not in row:
        raise ValueError("请选择文件夹或主体")
    return row


def folder(name, parent_id=None):
    with transaction() as tx:
        _parent(tx, parent_id)
        return tx.put(dict(id=_new("fld"), name=_title(name), parent_id=parent_id, item_ids=[]))


def _handle(name, custom, exclude=None, extra=()):
    existing = {s["handle"] for s in _all("subjects") if s["id"] != exclude} | set(extra)
    if custom is None:
        return slug.dedupe(slug.generate(name), existing)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", custom) or len(custom) > 80:
        raise ValueError("@标识只支持小写字母、数字和连字符")
    if custom in existing:
        raise ValueError("@标识已被使用")
    return custom


def subject(name, description="", handle=None):
    with transaction() as tx:
        name = _title(name)
        return tx.put(dict(id=_new("sbj"), name=name, handle=_handle(name, handle),
                           description=description, cover_item_id=None, item_ids=[]))


def update(key, fields):
    if key == FAVORITES:
        raise ValueError("收藏不能修改")
    with transaction() as tx:
        row = tx.get(key)
        if key.startswith("itm_"):
            allowed = {"title"}
        elif key.startswith("sbj_"):
            allowed = {"name", "handle", "description", "cover_item_id"}
        else:
            allowed = {"name", "parent_id"}
        if not fields or fields.keys() - allowed:
            raise ValueError("此对象不支持该操作")
        row = {**row, **fields}
        for field in ("name", "title"):
            if field in fields:
                row[field] = _title(fields[field])
        if "handle" in fields:
            row["handle"] = _handle(row["name"], fields["handle"], key)
        if "cover_item_id" in fields and fields["cover_item_id"] not in row["item_ids"]:
            raise ValueError("封面必须是主体的素材")
        if "parent_id" in fields:
            parent = row["parent_id"]
            _parent(tx, parent)
            if parent and (parent == key or any(f["parent_id"] == key for f in _all("folders"))):
                raise ValueError("文件夹最多两层，不能移到这里")
        return tx.put(row)


def save_subject(key, revision, name, handle, description, additions, cover_index):
    with transaction() as tx:
        if key and not key.startswith("sbj_"):
            raise ValueError("请选择主体")
        row = tx.get(key) if key else dict(id=_new("sbj"), item_ids=[], cover_item_id=None)
        if key and row["revision"] != revision:
            raise ValueError("主体已更新，请重新打开")
        if len(row["item_ids"]) + len(additions) > 20:
            raise ValueError("一个主体最多添加 20 个素材")
        name = _title(name)
        updated = tx.put({**row, "name": name, "description": description, "handle": _handle(name, handle, key)})
        for source in additions:
            if isinstance(source, str):
                _copy_item(tx, source, updated["id"])
            else:
                _insert(tx, updated["id"], *source)
        result = tx.get(updated["id"])
        if cover_index is not None:
            if not 0 <= cover_index < len(result["item_ids"]):
                raise ValueError("请选择封面素材")
            result = tx.put({**result, "cover_item_id": result["item_ids"][cover_index]})
        return result


def _add(tx, owner, key):
    ids = [*owner["item_ids"], key]
    if owner["id"].startswith("sbj_"):
        if len(ids) > 20:
            raise ValueError("一个主体最多添加 20 个素材")
        owner = {**owner, "cover_item_id": owner.get("cover_item_id") or key}
    tx.put({**owner, "item_ids": ids})


def _remove(tx, owner, key):
    ids = [item for item in owner["item_ids"] if item != key]
    if owner.get("cover_item_id") == key:
        owner = {**owner, "cover_item_id": ids[0] if ids else None}
    tx.put({**owner, "item_ids": ids})


def _owner(key):
    for row in _all("folders") + _all("subjects"):
        if key in row["item_ids"]:
            return row
    raise FileNotFoundError(key)


def _insert(tx, owner_id, title, body, kind, suffix, source, key=None):
    owner = _container(tx, owner_id)
    key = key or _new("itm")
    digest = hashlib.sha256(body).hexdigest()
    if kind == "text":
        preview = body.decode("utf-8")[:1024]
        filename = "content.md"
    else:
        if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
            raise ValueError("文件格式不可用")
        filename = digest + suffix
    record = dict(id=key, title=_title(title), kind=kind, file=filename, sha256=digest,
                  bytes=len(body), source=source)
    if kind == "text":
        record["text_preview"] = preview
    if kind == "image":
        from PIL import Image

        try:
            with Image.open(BytesIO(body)) as image:
                record["width"], record["height"] = image.size
                image.verify()
        except (OSError, SyntaxError) as error:
            raise ValueError("无法读取图片") from error
    directory = _path(key).parent
    # Record the intent before creating bytes. Recovery completes a published journal first.
    with _pending_items().open("a", encoding="utf-8") as pending:
        pending.write(key + "\n")
        pending.flush()
        os.fsync(pending.fileno())
    directory.mkdir(parents=True, exist_ok=False)
    tx.created_dirs.append(directory)
    atomic_write_bytes(directory / filename, body)
    _add(tx, owner, key)
    return tx.put(record)


def insert(owner, title, body, kind, suffix, source):
    with transaction() as tx:
        return _insert(tx, owner, title, body, kind, suffix, source)


def media(key):
    if not key.startswith("itm_"):
        raise ValueError("请选择素材")
    row = _read(key)
    directory = _path(key).parent
    path = (directory / row["file"]).resolve()
    if path.parent != directory.resolve() or not path.is_file():
        raise FileNotFoundError(key)
    return row, path


def move(key, target):
    with transaction() as tx:
        if not key.startswith("itm_"):
            raise ValueError("请选择素材")
        row = tx.get(key)
        owner = _owner(key)
        if target != owner["id"]:
            _add(tx, _container(tx, target), key)
            _remove(tx, owner, key)
            row = tx.put(row)
        return row


def _copy_item(tx, key, owner, rename=False):
    row, path = media(key)
    title = row["title"] + " 副本" if rename else row["title"]
    return _insert(tx, owner, title, path.read_bytes(), row["kind"], path.suffix, row["source"])


def _copy_group(tx, row, parent=None, rename=True):
    source = row["id"]
    is_folder = source.startswith("fld_")
    name = row["name"] + " 副本" if rename else row["name"]
    copy = {**row, "id": _new("fld" if is_folder else "sbj"), "name": name, "item_ids": []}
    for field in ("revision", "created_at", "updated_at", "system"):
        copy.pop(field, None)
    if is_folder:
        copy["parent_id"] = parent
    else:
        copy.update(handle=_handle(name, None), cover_item_id=None)
    key = tx.put(copy)["id"]
    for original in row["item_ids"]:
        item = _copy_item(tx, original, key)
        if original == row.get("cover_item_id"):
            tx.put({**tx.get(key), "cover_item_id": item["id"]})
    if is_folder:
        for child in _all("folders"):
            if child["parent_id"] == source:
                _copy_group(tx, child, key, False)
    return tx.get(key)


def duplicate(key, target=None):
    with transaction() as tx:
        row = tx.get(key)
        if key.startswith("itm_"):
            return _copy_item(tx, key, target or _owner(key)["id"], rename=not target)
        if key == FAVORITES or target:
            raise ValueError("请选择素材")
        return _copy_group(tx, row, row.get("parent_id"))


def _tree(row):
    yield row
    for key in row.get("item_ids", []):
        yield _read(key)
    if row["id"].startswith("fld_"):
        for child in _all("folders"):
            if child["parent_id"] == row["id"]:
                yield from _tree(child)


def remove(key):
    if key == FAVORITES:
        raise ValueError("收藏不能删除")
    with transaction() as tx:
        row = tx.get(key)
        paths = []
        for entry in _tree(row):
            path = _path(entry["id"])
            paths.append(path.parent if entry["id"].startswith("itm_") else path)
        meta = {"key": key}
        commit = None
        if key.startswith("itm_"):
            owner = _owner(key)
            meta.update(owner=owner["id"], index=owner["item_ids"].index(key),
                        was_cover=owner.get("cover_item_id") == key)
            _remove(tx, owner, key)
            def commit():
                tx.commit()
                tx.rows.clear()
        elif row.get("parent_id"):
            meta["parent_id"] = row["parent_id"]
        if "handle" in row:
            meta["handle"] = row["handle"]
        return trash.move_to_trash("library", row.get("title") or row["name"], paths, meta, commit=commit)


def _restore(entry, restore_files):
    with transaction() as tx:
        meta = entry.meta
        parent = meta.get("owner") or meta.get("parent_id")
        if parent and not _path(parent).exists():
            raise trash.TrashConflict("请先还原原文件夹或主体")
        if meta.get("handle") and any(s["handle"] == meta["handle"] and s["id"] != meta["key"]
                                      for s in _all("subjects")):
            raise trash.TrashConflict("原主体的 @标识已被使用")
        if meta.get("parent_id") and tx.get(parent).get("parent_id"):
            raise trash.TrashConflict("原文件夹超过两层")
        if meta.get("owner"):
            owner = tx.get(parent)
            ids = list(owner["item_ids"])
            if meta["key"] not in ids:
                if parent.startswith("sbj_") and len(ids) >= 20:
                    raise trash.TrashConflict("主体的参考素材已满")
                ids.insert(meta["index"], meta["key"])
                owner["item_ids"] = ids
                if meta.get("was_cover"):
                    owner["cover_item_id"] = meta["key"]
                tx.put(owner)
        def finish():
            tx.commit()
            tx.rows.clear()
        restore_files(after=finish)


trash.register_restore_handler("library", _restore)
