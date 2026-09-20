"""团队库 API 路由：挂载 / 索引 / 内容 / 缩略图 / 采用 / 显示名。"""
from __future__ import annotations

import base64

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


def test_adopt_broken_asset_json_is_409(client, tmp_path, monkeypatch):
    folder = tmp_path / "lib"
    folder.mkdir()
    (folder / "a.png").write_bytes(_PNG)
    client.put("/api/profile", json={"display_name": "老王"})
    lib = client.post(
        "/api/team-libraries", json={"project_id": "p1", "path": str(folder), "name": None}
    ).json()
    entry = client.get(f"/api/team-libraries/{lib['library_id']}/assets").json()["entries"][0]

    from pydantic import ValidationError

    from character_workflow.lib.schemas import TeamAssetFile
    from viewer_server import team_library_routes

    def boom(**_kwargs):
        try:
            TeamAssetFile.model_validate({})
        except ValidationError as error:
            raise error

    monkeypatch.setattr(team_library_routes, "adopt_team_asset", boom)
    resp = client.post(
        f"/api/team-libraries/{lib['library_id']}/assets/{entry['id']}/adopt",
        json={"project_id": None},
    )
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "not_adoptable"


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
