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


# ------------------------------------------------------------------ P2：分享 / 编辑 / 撤回


def _studio_job_with_output(root, *, reference: bool = False, namespace: str = "studio"):
    """一条 Studio 图片 job，output_paths[0] 是真实文件；reference=True 时带一张上传参考。"""
    from character_workflow.lib.jobs import new_job_id, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus
    from character_workflow.lib.studio_jobs import studio_output_dir

    job_id = new_job_id()
    paths: list[str] = []
    if namespace == "studio":
        output = studio_output_dir(job_id) / "1.png"
        output.write_bytes(_PNG)
        paths.append(str(output))
    params: dict = {}
    if reference:
        upload = root / ".runtime" / "uploads" / f"{job_id}.png"
        upload.parent.mkdir(parents=True, exist_ok=True)
        upload.write_bytes(_PNG)
        params["reference_images"] = [str(upload)]
    return save_job(Job(
        job_id=job_id,
        character_id="c1" if namespace == "character" else "",
        prompt="一只红色的猫",
        submitted_at="2026-09-23T01:00:00Z",
        model="gpt-image-2",
        params=JobParams(**params),
        output_paths=paths,
        status=JobStatus.DONE,
        error=None,
        kind=JobKind.IMAGE,
        namespace=namespace,
        provider="tuzi",
        alias="tuzi-main",
    ))


def _broadcasts(monkeypatch) -> list[tuple[str, dict]]:
    from viewer_server import watcher

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(watcher.hub, "broadcast", lambda event, data: events.append((event, data)))
    return events


def _share_job(client, library_id: str, job_id: str, **extra):
    return client.post(
        f"/api/team-libraries/{library_id}/share",
        json={
            "source": {"kind": "job_output", "job_id": job_id, "output_index": 0},
            "title": "红猫", "tags": ["猫"], **extra,
        },
    )


@pytest.fixture
def shared_lib(client, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    return _mount(client, "canvas-1", folder), folder


def test_share_job_output_returns_refreshed_entry_and_broadcasts_added(
    client, isolated_data_root, shared_lib, monkeypatch
):
    lib, _ = shared_lib
    events = _broadcasts(monkeypatch)
    job = _studio_job_with_output(isolated_data_root, reference=True)
    resp = _share_job(client, lib["library_id"], job.job_id)
    assert resp.status_code == 201, resp.text
    entry = resp.json()
    assert entry["id"].startswith("ta_") and entry["kind"] == "generation"
    assert entry["status"] == "ready" and entry["model"] == "gpt-image-2"
    assert entry["title"] == "红猫" and entry["author"] == "老王"
    listed = client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()["entries"]
    assert [e["id"] for e in listed] == [entry["id"]]
    assert events == [(
        "team-library-changed",
        {"library_id": lib["library_id"], "asset_id": entry["id"], "kind": "generation",
         "author": "老王", "change": "added"},
    )]


def test_share_creation_asset(client, shared_lib):
    from character_workflow.lib.creation_assets import create_media_asset_from_bytes

    lib, _ = shared_lib
    asset = create_media_asset_from_bytes(
        title="一张图", body=_PNG, filename="a.png", mime_type="image/png", tags=[],
    )
    resp = client.post(
        f"/api/team-libraries/{lib['library_id']}/share",
        json={"source": {"kind": "creation_asset", "asset_id": asset.asset_id}, "title": "图"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["kind"] == "media" and resp.json()["model"] is None


def test_share_requires_profile(client, tmp_path, isolated_data_root):
    folder = tmp_path / "lib"
    folder.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    lib = _mount(client, "canvas-1", folder)
    (isolated_data_root / ".config" / "profile.json").unlink()
    job = _studio_job_with_output(isolated_data_root)
    resp = _share_job(client, lib["library_id"], job.job_id)
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "profile_required"


def test_share_unreachable_library_is_503(client, isolated_data_root, shared_lib):
    import shutil

    lib, folder = shared_lib
    shutil.rmtree(folder)
    job = _studio_job_with_output(isolated_data_root)
    resp = _share_job(client, lib["library_id"], job.job_id)
    assert resp.status_code == 503 and resp.json()["detail"]["code"] == "library_unreachable"


def test_share_not_found_cases_are_404(client, shared_lib):
    lib, _ = shared_lib
    assert _share_job(client, "lib_0000000000000000", "job-x").status_code == 404
    assert _share_job(client, lib["library_id"], "job-missing").status_code == 404
    missing_asset = client.post(
        f"/api/team-libraries/{lib['library_id']}/share",
        json={"source": {"kind": "creation_asset", "asset_id": "ca_missing"}, "title": "图"},
    )
    assert missing_asset.status_code == 404, missing_asset.text


def test_share_not_shareable_and_source_missing_are_422_with_code(
    client, isolated_data_root, shared_lib
):
    from pathlib import Path

    lib, _ = shared_lib
    character_job = _studio_job_with_output(isolated_data_root, namespace="character")
    resp = _share_job(client, lib["library_id"], character_job.job_id)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "not_shareable"
    assert resp.json()["detail"]["message"]

    gone = _studio_job_with_output(isolated_data_root)
    Path(gone.output_paths[0]).unlink()
    resp = _share_job(client, lib["library_id"], gone.job_id)
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "source_missing"


def test_share_blank_title_is_422_invalid(client, isolated_data_root, shared_lib):
    lib, folder = shared_lib
    job = _studio_job_with_output(isolated_data_root)
    resp = client.post(
        f"/api/team-libraries/{lib['library_id']}/share",
        json={"source": {"kind": "job_output", "job_id": job.job_id, "output_index": 0},
              "title": "   "},
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "invalid"
    assert not (folder / "shared").exists()


def test_share_large_refs_is_413_until_allowed(client, isolated_data_root, shared_lib, monkeypatch):
    from character_workflow.lib import team_library_share as share

    lib, _ = shared_lib
    monkeypatch.setattr(share, "LARGE_REFS_BYTES", 1)
    job = _studio_job_with_output(isolated_data_root, reference=True)
    resp = _share_job(client, lib["library_id"], job.job_id)
    assert resp.status_code == 413, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "refs_too_large" and detail["bytes"] == len(_PNG)
    allowed = _share_job(client, lib["library_id"], job.job_id, allow_large=True)
    assert allowed.status_code == 201, allowed.text


def _shared_entry(client, isolated_data_root, library_id: str) -> dict:
    job = _studio_job_with_output(isolated_data_root)
    resp = _share_job(client, library_id, job.job_id)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_update_shared_asset_returns_entry_and_broadcasts_updated(
    client, isolated_data_root, shared_lib, monkeypatch
):
    lib, _ = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    events = _broadcasts(monkeypatch)
    resp = client.put(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}",
        json={"title": "改名的猫", "tags": ["新"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "改名的猫" and resp.json()["tags"] == ["新"]
    assert [(e, d["asset_id"], d["change"]) for e, d in events] == [
        ("team-library-changed", entry["id"], "updated")
    ]


def test_withdraw_shared_asset_is_204_and_broadcasts_removed(
    client, isolated_data_root, shared_lib, monkeypatch
):
    lib, _ = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    events = _broadcasts(monkeypatch)
    resp = client.delete(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}")
    assert resp.status_code == 204, resp.text
    assert client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()["entries"] == []
    assert [(d["asset_id"], d["change"]) for _, d in events] == [(entry["id"], "removed")]


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
def test_edit_and_withdraw_error_codes(client, isolated_data_root, shared_lib, method):
    import shutil

    lib, folder = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    url = f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}"
    body = {"json": {"title": "改", "tags": []}} if method == "PUT" else {}

    client.put("/api/profile", json={"display_name": "小李"})
    forbidden = client.request(method, url, **body)
    assert forbidden.status_code == 403, forbidden.text
    assert forbidden.json()["detail"]["code"] == "not_author"

    client.put("/api/profile", json={"display_name": "老王"})
    missing = client.request(
        method, f"/api/team-libraries/{lib['library_id']}/assets/ta_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        **body,
    )
    assert missing.status_code == 404, missing.text
    unknown_lib = client.request(
        method, f"/api/team-libraries/lib_0000000000000000/assets/{entry['id']}", **body
    )
    assert unknown_lib.status_code == 404

    (isolated_data_root / ".config" / "profile.json").unlink()
    no_profile = client.request(method, url, **body)
    assert no_profile.status_code == 409 and no_profile.json()["detail"]["code"] == "profile_required"

    client.put("/api/profile", json={"display_name": "老王"})
    shutil.rmtree(folder)
    offline = client.request(method, url, **body)
    assert offline.status_code == 503 and offline.json()["detail"]["code"] == "library_unreachable"


def test_update_blank_title_is_422_invalid(client, isolated_data_root, shared_lib):
    lib, _ = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    resp = client.put(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}",
        json={"title": "  ", "tags": []},
    )
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid"


# ------------------------------------------------------------------ P2：列表 / 相关配方 / 过时


def test_list_without_project_id_dedupes_by_library(client, tmp_path):
    import shutil

    old = tmp_path / "old"
    old.mkdir()
    client.put("/api/profile", json={"display_name": "老王"})
    first = _mount(client, "canvas-1", old)
    new = tmp_path / "new"
    shutil.copytree(old, new)
    _mount(client, "canvas-2", new)
    other_dir = tmp_path / "other"
    other_dir.mkdir()
    other = _mount(client, "canvas-2", other_dir)

    rows = client.get("/api/team-libraries").json()
    assert sorted(r["library_id"] for r in rows) == sorted([first["library_id"], other["library_id"]])
    same = next(r for r in rows if r["library_id"] == first["library_id"])
    # get_mount 选中的是最近挂载的可达记录：画布 2 那条。
    assert same["project_id"] == "canvas-2" and same["mount_path"] == str(new.resolve())
    assert len(client.get("/api/team-libraries", params={"project_id": "canvas-1"}).json()) == 1


def test_related_merges_libraries_sorted_and_capped(client, isolated_data_root, tmp_path):
    import shutil

    client.put("/api/profile", json={"display_name": "老王"})
    folders = [tmp_path / "a", tmp_path / "b", tmp_path / "offline"]
    for folder in folders:
        folder.mkdir()
    (folders[0] / "raw.png").write_bytes(_PNG)
    libs = [_mount(client, "canvas-1", folder) for folder in folders]
    _mount(client, "canvas-2", tmp_path / "a")  # 同库另一画布挂载不影响画布 1 的结果
    shared: list[str] = []
    for n in range(22):
        shared.append(_shared_entry(client, isolated_data_root, libs[n % 2]["library_id"])["id"])
    _shared_entry(client, isolated_data_root, libs[2]["library_id"])
    shutil.rmtree(folders[2])

    resp = client.get("/api/team-libraries/related", params={"project_id": "canvas-1"})
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["entry"]["id"] for r in rows] == list(reversed(shared))[:20]
    assert {r["library_id"] for r in rows} == {libs[0]["library_id"], libs[1]["library_id"]}
    assert all(r["entry"]["kind"] == "generation" for r in rows)
    assert rows[0]["library_name"] == libs[1]["name"]
    assert client.get("/api/team-libraries/related", params={"project_id": "canvas-x"}).json() == []


def test_related_requires_project_id_and_is_not_swallowed_by_library_routes(client):
    assert client.get("/api/team-libraries/related").status_code == 422
    resp = client.get("/api/team-libraries/related", params={"project_id": "canvas-1"})
    assert resp.status_code == 200 and resp.json() == []


def test_staleness_reports_all_four_states(client, isolated_data_root, shared_lib):
    from character_workflow.lib.creation_assets import create_media_asset_from_bytes

    lib, _ = shared_lib
    own = create_media_asset_from_bytes(
        title="本机图", body=_PNG, filename="a.png", mime_type="image/png", tags=[],
    )
    assert client.get(f"/api/creation-assets/{own.asset_id}/staleness").json() == {
        "status": "unknown"
    }

    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    adopted = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": "canvas-1"},
    )
    assert adopted.status_code == 200, adopted.text
    asset_id = adopted.json()["asset"]["asset_id"]
    url = f"/api/creation-assets/{asset_id}/staleness"
    assert client.get(url).json() == {"status": "fresh"}

    client.put(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}",
        json={"title": "改过", "tags": []},
    )
    assert client.get(url).json() == {"status": "stale"}

    client.delete(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}")
    assert client.get(url).json() == {"status": "withdrawn"}


def test_staleness_unknown_asset_is_404(client):
    assert client.get("/api/creation-assets/ca_missing/staleness").status_code == 404


@pytest.mark.parametrize(("method", "path", "capability"), [
    ("POST", "/api/team-libraries/lib_x/share", "edit"),
    ("PUT", "/api/team-libraries/lib_x/assets/ta_x", "edit"),
    ("DELETE", "/api/team-libraries/lib_x/assets/ta_x", "edit"),
    ("GET", "/api/team-libraries/related", "read"),
    ("GET", "/api/creation-assets/ca_x/staleness", "read"),
])
def test_new_routes_capabilities(method, path, capability):
    from viewer_server.connection_capabilities import local_capability

    assert local_capability(method, path) == capability


# ------------------------------------------------------------------ P2：评审第 1 轮


@pytest.fixture
def raw_client(isolated_data_root):
    """另起一个 app（同一 data root），服务端异常回 500 而不是在测试里抛出。"""
    return TestClient(
        base_url="http://127.0.0.1",
        app=build_app(dist_dir=isolated_data_root / "dist"),
        raise_server_exceptions=False,
    )


def test_share_with_corrupted_job_file_is_500_not_invalid(
    raw_client, isolated_data_root, shared_lib
):
    lib, folder = shared_lib
    job = _studio_job_with_output(isolated_data_root)
    (isolated_data_root / ".runtime" / "jobs" / f"{job.job_id}.json").write_text(
        "{不是 json", encoding="utf-8"
    )
    resp = _share_job(raw_client, lib["library_id"], job.job_id)
    assert resp.status_code == 500, resp.text
    assert list(folder.rglob("asset.json")) == []


def test_share_meta_invalid_vs_body_limits(client, isolated_data_root, shared_lib):
    lib, _ = shared_lib
    job = _studio_job_with_output(isolated_data_root)
    long_tag = _share_job(client, lib["library_id"], job.job_id, tags=["长" * 41])
    assert long_tag.status_code == 422 and long_tag.json()["detail"]["code"] == "invalid"
    too_long_title = client.post(
        f"/api/team-libraries/{lib['library_id']}/share",
        json={"source": {"kind": "job_output", "job_id": job.job_id, "output_index": 0},
              "title": "长" * 121},
    )
    assert too_long_title.status_code == 422
    assert isinstance(too_long_title.json()["detail"], list)


def test_share_os_error_mid_write_is_503_with_path(client, isolated_data_root, shared_lib, monkeypatch):
    from character_workflow.lib import team_library_share as share

    lib, folder = shared_lib

    def disk_full(*_args, **_kwargs):
        raise OSError(28, "No space left on device", "/Volumes/team/shared/x.png")

    monkeypatch.setattr(share, "_stage_media", disk_full)
    job = _studio_job_with_output(isolated_data_root)
    resp = _share_job(client, lib["library_id"], job.job_id)
    assert resp.status_code == 503, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "library_unreachable"
    assert "/Volumes/team/shared/x.png" in detail["message"]
    assert [p.name for p in (folder / "shared").rglob("*") if p.name.startswith(".tmp")] == []


def test_update_permission_error_is_503_but_not_author_stays_403(
    client, isolated_data_root, shared_lib, monkeypatch
):
    from character_workflow.lib import team_library_share as share

    lib, _ = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])
    url = f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}"

    def denied(path, _data):
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(share, "atomic_write_json", denied)
    resp = client.put(url, json={"title": "改", "tags": []})
    assert resp.status_code == 503, resp.text
    assert "asset.json" in resp.json()["detail"]["message"]

    client.put("/api/profile", json={"display_name": "小李"})
    forbidden = client.put(url, json={"title": "改", "tags": []})
    assert forbidden.status_code == 403 and forbidden.json()["detail"]["code"] == "not_author"


def test_creation_asset_state_error_maps_to_409(client, shared_lib, monkeypatch):
    from character_workflow.lib.creation_assets import CreationAssetStateError
    from viewer_server import team_library_routes

    lib, _ = shared_lib

    def broken(*_args, **_kwargs):
        raise CreationAssetStateError("创作资产库状态损坏")

    monkeypatch.setattr(team_library_routes, "share_creation_asset", broken)
    resp = client.post(
        f"/api/team-libraries/{lib['library_id']}/share",
        json={"source": {"kind": "creation_asset", "asset_id": "ca_x"}, "title": "图"},
    )
    assert resp.status_code == 409 and resp.json()["detail"] == "创作资产库状态损坏"


def test_refresh_failure_after_write_is_500_naming_asset(
    client, isolated_data_root, shared_lib, monkeypatch
):
    from viewer_server import watcher

    lib, folder = shared_lib
    entry = _shared_entry(client, isolated_data_root, lib["library_id"])

    def broken_refresh(_mount):
        raise OSError("index 写不进去")

    monkeypatch.setattr(watcher, "refresh_team_library", broken_refresh)
    job = _studio_job_with_output(isolated_data_root)
    shared = _share_job(client, lib["library_id"], job.job_id)
    assert shared.status_code == 500, shared.text
    detail = shared.json()["detail"]
    written = [p.name for p in (folder / "shared").glob("*/ta_*") if p.name != entry["id"]]
    assert detail["asset_id"] == written[0] and "请重新扫描" in detail["message"]

    withdrawn = client.delete(f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}")
    assert withdrawn.status_code == 500
    assert withdrawn.json()["detail"]["asset_id"] == entry["id"]
    assert "请重新扫描" in withdrawn.json()["detail"]["message"]


def test_mount_broadcasts_initial_entries(client, tmp_path, monkeypatch):
    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    events = _broadcasts(monkeypatch)
    lib = _mount(client, "canvas-1", folder)
    assert [(d["library_id"], d["kind"], d["change"]) for _, d in events] == [
        (lib["library_id"], "raw", "added")
    ]


def test_related_skips_library_without_index(client, isolated_data_root, tmp_path):
    from character_workflow.lib import team_library_index as idx

    client.put("/api/profile", json={"display_name": "老王"})
    scanned_dir, unscanned_dir = tmp_path / "a", tmp_path / "b"
    scanned_dir.mkdir()
    unscanned_dir.mkdir()
    scanned = _mount(client, "canvas-1", scanned_dir)
    unscanned = _mount(client, "canvas-1", unscanned_dir)
    kept = _shared_entry(client, isolated_data_root, scanned["library_id"])
    _shared_entry(client, isolated_data_root, unscanned["library_id"])
    (idx.cache_dir(unscanned["library_id"]) / "index.json").unlink()

    resp = client.get("/api/team-libraries/related", params={"project_id": "canvas-1"})
    assert resp.status_code == 200, resp.text
    assert [r["entry"]["id"] for r in resp.json()] == [kept["id"]]
