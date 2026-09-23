"""团队库 API 路由：挂载 / 索引 / 内容 / 缩略图 / 采用 / 显示名。"""
from __future__ import annotations

import base64
import hashlib
import json

import pytest
from tests.local_client import LocalTestClient as TestClient

from viewer_server.server_app import build_app


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def test_profile_get_put(client):
    assert client.get("/api/profile").json() == {"display_name": None}
    assert client.put("/api/profile", json={"display_name": "老王"}).status_code == 200
    assert client.get("/api/profile").json() == {"display_name": "老王"}


def test_mount_requires_profile_then_lists_and_unmounts(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    denied = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    )
    assert denied.status_code == 409 and denied.json()["detail"]["code"] == "profile_required"
    client.put("/api/profile", json={"display_name": "老王"})
    created = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert view["reachable"] and view["asset_count"] == 0 and view["scanned_at"]
    listed = client.get("/api/team-libraries", params={"project_id": "p1"}).json()
    assert listed[0]["library_id"] == view["library_id"]
    dropped = client.delete(
        f"/api/team-libraries/{view['library_id']}", params={"project_id": "p1"}
    )
    assert dropped.status_code == 204
    assert client.get("/api/team-libraries", params={"project_id": "p1"}).json() == []


def test_assets_content_thumb_and_adopt(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    page = client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()
    entry = page["entries"][0]
    assert entry["kind"] == "raw" and page["next_cursor"] is None
    content = client.get(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/content")
    assert content.content == _PNG
    thumb = client.get(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/thumb", params={"w": 128}
    )
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"
    adopted = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": "p1"},
    )
    assert adopted.status_code == 200 and adopted.json()["created"] is True
    again = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": "p1"},
    )
    assert again.json()["created"] is False
    assets = client.get("/api/creation-assets", params={"kind": "media"}).json()["assets"]
    assert assets[0]["adopted_from"]["asset_id"] == entry["id"]
    assert sorted(p.name for p in folder.iterdir()) == [".atelier-library.json", "a.png"]


def test_unreachable_library_returns_503(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    import shutil

    shutil.rmtree(folder)
    listed = client.get("/api/team-libraries", params={"project_id": "p1"}).json()[0]
    assert listed["reachable"] is False
    resp = client.get(f"/api/team-libraries/{lib['library_id']}/assets")
    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "library_unreachable"


def test_unknown_library_404(client):
    assert client.get("/api/team-libraries/lib_0000000000000000/assets").status_code == 404


def test_mount_rejects_data_root_and_runtime_paths(client, isolated_data_root):
    client.put("/api/profile", json={"display_name": "老王"})
    for path in (
        isolated_data_root,
        isolated_data_root.parent,
        isolated_data_root / ".runtime",
    ):
        resp = client.post(
            "/api/team-libraries", json={"project_id": "p1", "path": str(path), "name": None}
        )
        assert resp.status_code == 422, (path, resp.text)
    assert client.get("/api/team-libraries", params={"project_id": "p1"}).json() == []


def test_bad_cursor_is_422_not_500(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    resp = client.get(
        f"/api/team-libraries/{lib['library_id']}/assets", params={"cursor": "不是游标"}
    )
    assert resp.status_code == 422, resp.text


def test_prompt_entry_content_is_404(client, tmp_path):
    from character_workflow.lib.schemas import (
        CreationPromptAssetContent,
        CreationPromptTextSegment,
        TeamAssetAuthor,
        TeamAssetFile,
    )
    from character_workflow.lib.team_library import new_ulid

    folder = tmp_path / "lib"
    asset_dir = folder / "shared" / "老王" / f"ta_{new_ulid()}"
    asset_dir.mkdir(parents=True)
    asset = TeamAssetFile(
        asset_id=asset_dir.name,
        kind="prompt",
        title="一句提示词",
        tags=[],
        author=TeamAssetAuthor(display_name="老王"),
        shared_at="2026-09-20T00:00:00+00:00",
        updated_at="2026-09-20T00:00:00+00:00",
        prompt=CreationPromptAssetContent(
            kind="prompt", segments=[CreationPromptTextSegment(kind="text", text="一只猫")]
        ),
    )
    (asset_dir / "asset.json").write_text(asset.model_dump_json(), encoding="utf-8")
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    entry = client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()["entries"][0]
    assert entry["kind"] == "prompt"
    content = client.get(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/content")
    assert content.status_code == 404
    thumb = client.get(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/thumb")
    assert thumb.status_code == 404
    adopted = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": None},
    )
    assert adopted.status_code == 200 and adopted.json()["asset"]["kind"] == "prompt"


def test_adopt_broken_asset_json_is_409(client, tmp_path):
    """库里 asset.json 坏掉（generation 缺 snapshot）→ 409，绝不 500。

    坏文件来自别人的机器，随时可能同步进来；它只是「这条现在不能采用」，不是本机故障。
    """
    from character_workflow.lib.team_library import new_ulid

    folder = tmp_path / "lib"
    asset_dir = folder / "shared" / "老王" / f"ta_{new_ulid()}"
    asset_dir.mkdir(parents=True)
    (asset_dir / "a.png").write_bytes(_PNG)
    # kind=generation 但没有 snapshot：TeamAssetFile 的 validator 会在采用时读盘才炸。
    (asset_dir / "asset.json").write_text(
        json.dumps({
            "team_asset_version": 1,
            "asset_id": asset_dir.name,
            "kind": "generation",
            "title": "半成品",
            "tags": [],
            "author": {"display_name": "老王"},
            "shared_at": "2026-09-20T00:00:00+00:00",
            "updated_at": "2026-09-20T00:00:00+00:00",
            "media": {
                "filename": "a.png",
                "mime_type": "image/png",
                "bytes": len(_PNG),
                "sha256": hashlib.sha256(_PNG).hexdigest(),
            },
        }),
        encoding="utf-8",
    )
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    entry = client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()["entries"][0]
    resp = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": None},
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "not_adoptable"


def test_rescan_returns_fresh_count(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    assert lib["asset_count"] == 0
    (folder / "a.png").write_bytes(_PNG)
    rescanned = client.post(f"/api/team-libraries/{lib['library_id']}/rescan")
    assert rescanned.status_code == 200 and rescanned.json()["asset_count"] == 1


def test_read_endpoint_does_not_scan_when_index_is_missing(client, tmp_path):
    """读端点不顺手扫：扫描要走整棵工作副本，挂在读上就是每次刷新并发全量扫描。"""
    from character_workflow.lib import team_library_index as idx

    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    assert client.get(f"/api/team-libraries/{lib['library_id']}/assets").status_code == 200

    (idx.cache_dir(lib["library_id"]) / "index.json").unlink()
    missing = client.get(f"/api/team-libraries/{lib['library_id']}/assets")
    assert missing.status_code == 503, missing.text
    assert missing.json()["detail"]["code"] == "library_unreachable"
    assert not (idx.cache_dir(lib["library_id"]) / "index.json").exists()

    assert client.post(f"/api/team-libraries/{lib['library_id']}/rescan").status_code == 200
    restored = client.get(f"/api/team-libraries/{lib['library_id']}/assets")
    assert restored.status_code == 200 and len(restored.json()["entries"]) == 1


def test_limit_is_clamped_not_rejected(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    for n in range(3):
        (folder / f"a{n}.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    url = f"/api/team-libraries/{lib['library_id']}/assets"

    huge = client.get(url, params={"limit": 999})
    assert huge.status_code == 200 and len(huge.json()["entries"]) == 3

    zero = client.get(url, params={"limit": 0})
    assert zero.status_code == 200 and len(zero.json()["entries"]) == 1

    negative = client.get(url, params={"limit": -5})
    assert negative.status_code == 200 and len(negative.json()["entries"]) == 1


def test_broken_mount_table_is_500_naming_the_file(client, isolated_data_root):
    """挂载表坏掉是磁盘状态故障：报 500 并说清是哪个文件，画师才修得动。"""
    path = isolated_data_root / ".config" / "team-libraries.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"schema_version": 1, "mounts": "不是数组"}', encoding="utf-8")
    resp = client.get("/api/team-libraries", params={"project_id": "p1"})
    assert resp.status_code == 500, resp.text
    assert "team-libraries.json" in json.dumps(resp.json(), ensure_ascii=False)


class _FakeObserver:
    """记录 schedule / unschedule，不真起 watchdog 线程。"""

    def __init__(self):
        self.scheduled: list[str] = []
        self.unscheduled: list[str] = []

    def schedule(self, handler, path, recursive=False):
        from pathlib import Path

        if not Path(path).is_dir():
            raise OSError(path)
        self.scheduled.append(path)
        return path

    def unschedule(self, watch):
        self.unscheduled.append(watch)


@pytest.fixture
def observer(monkeypatch):
    from viewer_server import watcher

    fake = _FakeObserver()
    monkeypatch.setattr(watcher, "_observer", fake)
    monkeypatch.setattr(watcher, "_team_watches", {})
    monkeypatch.setattr(watcher, "_team_handlers", {})
    return fake


def _mount(client, project_id, folder):
    resp = client.post(
        "/api/team-libraries", json={"project_id": project_id, "path": str(folder), "name": None}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_library_on_two_canvases_reads_the_reachable_mount(client, tmp_path, observer):
    """同一个库先挂在画布 1，盘符变了又挂到画布 2：读端点要走可达的那条，watcher 跟着换路径。"""
    import shutil

    old = tmp_path / "old"
    old.mkdir()
    (old / "a.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    first = _mount(client, "canvas-1", old)
    new = tmp_path / "new"
    shutil.copytree(old, new)
    second = _mount(client, "canvas-2", new)
    assert second["library_id"] == first["library_id"]
    shutil.rmtree(old)
    resp = client.get(f"/api/team-libraries/{first['library_id']}/assets")
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["entries"]) == 1
    assert observer.scheduled == [str(old.resolve()), str(new.resolve())]
    assert observer.unscheduled == [str(old.resolve())]


def test_rescan_watches_library_that_was_offline_at_startup(client, tmp_path, monkeypatch):
    from viewer_server import watcher

    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    monkeypatch.setattr(watcher, "_observer", None)
    lib = _mount(client, "canvas-1", folder)
    fake = _FakeObserver()
    monkeypatch.setattr(watcher, "_observer", fake)
    monkeypatch.setattr(watcher, "_team_watches", {})
    monkeypatch.setattr(watcher, "_team_handlers", {})
    assert client.post(f"/api/team-libraries/{lib['library_id']}/rescan").status_code == 200
    assert fake.scheduled == [str(folder.resolve())]
    assert client.post(f"/api/team-libraries/{lib['library_id']}/rescan").status_code == 200
    assert fake.scheduled == [str(folder.resolve())]


def test_unmount_moves_watch_to_the_remaining_mount(client, tmp_path, observer):
    import shutil

    first_dir = tmp_path / "a"
    first_dir.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    lib = _mount(client, "canvas-1", first_dir)
    second_dir = tmp_path / "b"
    shutil.copytree(first_dir, second_dir)
    _mount(client, "canvas-2", second_dir)
    client.delete(f"/api/team-libraries/{lib['library_id']}", params={"project_id": "canvas-2"})
    a, b = str(first_dir.resolve()), str(second_dir.resolve())
    assert observer.scheduled == [a, b, a]
    client.delete(f"/api/team-libraries/{lib['library_id']}", params={"project_id": "canvas-1"})
    assert observer.unscheduled[-1] == str(first_dir.resolve())


def test_deleting_canvas_drops_its_mounts_and_watch(client, tmp_path, observer):
    created = client.post("/api/canvas/projects", json={"name": "团队库画布"})
    assert created.status_code == 201, created.text
    project_id = created.json()["project_id"]
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    _mount(client, project_id, folder)
    revision = client.get(f"/api/canvas/projects/{project_id}/document").json()["revision"]
    deleted = client.request(
        "DELETE", f"/api/canvas/projects/{project_id}", json={"expected_revision": revision}
    )
    assert deleted.status_code == 204, deleted.text
    assert client.get("/api/team-libraries", params={"project_id": project_id}).json() == []
    assert observer.unscheduled == [str(folder.resolve())]


def test_mount_rejects_any_path_inside_data_root(client, isolated_data_root):
    client.put("/api/profile", json={"display_name": "老王"})
    inside = isolated_data_root / "canvases" / "canvas-abc"
    inside.mkdir(parents=True)
    resp = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(inside), "name": None}
    )
    assert resp.status_code == 422, resp.text
    assert not (inside / ".atelier-library.json").exists()


def test_blank_display_name_is_422(client):
    resp = client.put("/api/profile", json={"display_name": "   "})
    assert resp.status_code == 422, resp.text
    assert client.get("/api/profile").json() == {"display_name": None}
