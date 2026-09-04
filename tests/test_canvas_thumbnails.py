"""画布图片按显示宽度下发缩略图，而不是每张都发原图。"""
from __future__ import annotations

import json
from io import BytesIO

import pytest
from tests.local_client import LocalTestClient as TestClient
from PIL import Image

from viewer_server.server_app import build_app


def _png(width: int, height: int) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (width, height), (200, 90, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def client(isolated_data_root):
    (isolated_data_root / ".config" / "keys.json").write_text(json.dumps({
        "version": 1, "default_alias": None, "keys": [],
    }))
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _upload(client: TestClient, body: bytes, name: str = "wide.png") -> tuple[str, str]:
    created = client.post("/api/canvas/projects", json={"name": "缩略图"})
    assert created.status_code == 201, created.text
    project_id = created.json()["project_id"]
    uploaded = client.post(
        f"/api/canvas/projects/{project_id}/uploads",
        files={"file": (name, body, "image/png")},
        data={"expected_revision": "0"},
    )
    assert uploaded.status_code == 201, uploaded.text
    return project_id, uploaded.json()["version"]["version_id"]


def _size(body: bytes) -> tuple[int, int]:
    with Image.open(BytesIO(body)) as opened:
        return opened.size


def test_display_width_gets_a_downscaled_webp_not_the_original(client):
    original = _png(2048, 1024)
    project_id, version_id = _upload(client, original)
    url = f"/api/canvas/projects/{project_id}/versions/{version_id}/media"

    full = client.get(url)
    assert full.status_code == 200
    assert full.content == original

    # 320 CSS px 的节点卡：档位向上取到 512，位图小了 16 倍。
    thumbnail = client.get(url, params={"w": 320})
    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/webp"
    assert _size(thumbnail.content) == (512, 256)
    assert len(thumbnail.content) < len(original)

    # 第二次请求走缓存，内容逐字节相同。
    assert client.get(url, params={"w": 320}).content == thumbnail.content
    # 缩略图按 URL 维度不可变；连接中间件不得把它覆盖成 no-store（本机直服也过浏览器缓存）。
    assert thumbnail.headers["cache-control"] == "private, max-age=31536000, immutable"


def test_requests_wider_than_the_top_tier_and_small_originals_get_the_original(client):
    original = _png(2048, 1024)
    project_id, version_id = _upload(client, original)
    url = f"/api/canvas/projects/{project_id}/versions/{version_id}/media"
    assert client.get(url, params={"w": 4000}).content == original

    small = _png(200, 100)
    small_project, small_version = _upload(client, small, "small.png")
    small_url = f"/api/canvas/projects/{small_project}/versions/{small_version}/media"
    # 原图本来就比档位小，缩略图只会更糊也更慢——照发原图。
    assert client.get(small_url, params={"w": 320}).content == small


def test_thumbnail_cache_lives_outside_the_project_and_goes_with_it(client, isolated_data_root):
    project_id, version_id = _upload(client, _png(2048, 1024))
    url = f"/api/canvas/projects/{project_id}/versions/{version_id}/media"
    assert client.get(url, params={"w": 320}).status_code == 200

    cache = isolated_data_root / ".runtime" / "canvas-thumbnails" / project_id
    assert list(cache.glob("*.webp")), "缩略图应当落盘缓存"
    # 派生文件不能进项目目录：导出包会按 content_versions 逐一核对项目目录里的文件。
    project_dir = isolated_data_root / "canvases" / project_id
    assert not list(project_dir.rglob("*.webp"))

    revision = client.get(f"/api/canvas/projects/{project_id}/document").json()["revision"]
    deleted = client.request(
        "DELETE",
        f"/api/canvas/projects/{project_id}",
        json={"expected_revision": revision},
    )
    assert deleted.status_code == 204, deleted.text
    assert not cache.exists()
