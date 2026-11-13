"""模型公告源：打包兜底、远程拉取写缓存、按本机版本过滤。"""
from __future__ import annotations

import pytest
import requests

from character_workflow.lib import announcement_feed
from tests.local_client import LocalTestClient as TestClient
from viewer_server.server_app import build_app


def _item(item_id: str, version: str, image: str = "https://example.com/a.png") -> dict:
    return {"id": item_id, "date": "2026-11-20", "version": version, "title": item_id,
            "summary": "", "imageUrl": image, "models": [{"name": "M", "ids": ["m-1"]}]}


class _Response:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def test_bundled_feed_is_valid_and_filtered_by_app_version(isolated_data_root):
    ids = [item.id for item in announcement_feed.bundled().announcements]
    assert ids and len(ids) == len(set(ids))
    # 5.5 的公告需要 5.136.0：老客户端还没有它的能力登记，不该弹。
    assert "2026-11-seedream-5-5" not in [item["id"] for item in announcement_feed.visible("5.135.0")]
    assert "2026-11-seedream-5-5" in [item["id"] for item in announcement_feed.visible("5.137.0")]
    # ADR-0032：0.5.x 新于任何 5.x。
    assert len(announcement_feed.visible("0.5.134")) == len(ids)


def test_sync_falls_back_to_github_and_caches_remote_feed(isolated_data_root, monkeypatch):
    calls = []

    def fake_get(url, timeout):
        calls.append(url)
        if "cnb.cool" in url:
            raise requests.ConnectionError("cnb down")
        return _Response({"announcements": [_item("remote-only", "5.137.0")]})

    monkeypatch.setattr(announcement_feed.requests, "get", fake_get)
    assert announcement_feed.sync() is not None
    assert [url.split("/")[2] for url in calls] == ["cnb.cool", "raw.githubusercontent.com"]
    assert [item["id"] for item in announcement_feed.visible("5.137.0")] == ["remote-only"]


def test_invalid_remote_feed_keeps_previous_cache(isolated_data_root, monkeypatch):
    responses = iter([
        {"announcements": [_item("good", "5.137.0")]},
        {"announcements": [_item("bad", "5.137.0", image="http://example.com/a.png")]},
        {"announcements": [_item("bad", "5.137.0", image="http://example.com/a.png")]},
    ])
    monkeypatch.setattr(announcement_feed.requests, "get", lambda url, timeout: _Response(next(responses)))
    announcement_feed.sync()
    assert announcement_feed.sync() is None
    assert [item["id"] for item in announcement_feed.visible("5.137.0")] == ["good"]


@pytest.mark.parametrize("version, expected", [("5.136.0", True), ("5.135.0", False)])
def test_announcements_endpoint_uses_installed_version(isolated_data_root, monkeypatch, version, expected):
    monkeypatch.setattr("viewer_server.connection_status.app_version", lambda: version)
    client = TestClient(build_app(), base_url="http://127.0.0.1")
    response = client.get("/api/announcements")
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()["announcements"]]
    assert ("2026-11-seedream-5-5" in ids) is expected
    assert all("imageUrl" in item for item in response.json()["announcements"])
