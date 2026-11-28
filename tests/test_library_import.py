import hashlib
import json
from io import BytesIO

import pytest
from PIL import Image

from character_workflow.lib import data_root, library, library_import, trash
from character_workflow.lib.atomic_io import atomic_write_json


def seed_legacy():
    source = data_root.creation_assets_dir()
    buffer = BytesIO()
    Image.new("RGB", (10, 10), "orange").save(buffer, format="PNG")
    body = buffer.getvalue()
    digest = hashlib.sha256(body).hexdigest()
    file = source / "blobs" / (digest + ".png")
    file.parent.mkdir(parents=True)
    file.write_bytes(body)
    preview = source / "prompt-previews/old-prompt" / (digest[:16] + ".png")
    preview.parent.mkdir(parents=True)
    preview.write_bytes(body)
    common = dict(created_at="2026-11-27", updated_at="2026-11-27")
    atomic_write_json(source / "catalog.json", {"updated_at": "now", "schema_version": 4, "assets": [
        {**common, "asset_id": "old-image", "kind": "media", "title": "海边", "project_ids": ["canvas-test"],
         "category": "背景", "content": dict(kind="media", path=f"creation-assets/blobs/{file.name}",
          mime_type="image/png", bytes=len(body), sha256=digest, filename="beach.png")},
        {**common, "asset_id": "old-prompt", "kind": "prompt", "title": "日落", "content": dict(
            kind="prompt", segments=[{"kind": "text", "text": "日落时分"}],
            preview_images=[dict(file=preview.name, mime_type="image/png", width=10, height=10, added_at="now")])}
    ]})
    return file


def test_failed_import_retries_once_and_keeps_project_identity(monkeypatch):
    file = seed_legacy()
    body = file.read_bytes()
    file.unlink()
    with pytest.raises(FileNotFoundError):
        library_import.import_legacy()
    assert data_root.creation_assets_dir().exists()
    marker = data_root.runtime_dir() / "library-import.json"
    assert json.loads(marker.read_text())["status"] == "failed"
    file.write_bytes(body)
    original = trash.move_to_trash
    def fail(*args, **kwargs):
        raise OSError("interrupted")
    monkeypatch.setattr(trash, "move_to_trash", fail)
    with pytest.raises(OSError):
        library_import.import_legacy()
    monkeypatch.setattr(trash, "move_to_trash", original)
    result = library_import.import_legacy()
    assert result["items"] == 3 and result["retained"] == 1
    assert not data_root.creation_assets_dir().exists()
    items = list(library.catalog()["items"].values())
    assert len(items) == 3
    text, = [i for i in items if i["kind"] == "text"]
    assert library.media(text["id"])[1].read_text() == "日落时分"
    record, = json.loads((data_root.project_references_dir() / "catalog.json").read_text())["assets"]
    assert (record["asset_id"], record["category"], record["project_ids"]) == ("old-image", "背景", ["canvas-test"])
    assert (data_root.resolve_data_root() / record["content"]["path"]).read_bytes() == body
    assert library_import.import_legacy() == result
    trash.restore(result["trash_id"])
    assert library_import.import_legacy() == result
    assert data_root.creation_assets_dir().exists()
