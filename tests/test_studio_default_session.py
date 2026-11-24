from concurrent.futures import ThreadPoolExecutor

import pytest

from character_workflow.lib import studio_agent_sessions as sessions
from tests.local_client import LocalTestClient
from viewer_server.server_app import build_app


BASE = "/api/studio/agent/sessions"
DEFAULT = "session-default-studio"


@pytest.fixture
def client(isolated_data_root):
    # 不进入应用 lifespan，直接覆盖首次请求触发的按需创建。
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root))
    yield client
    client.close()


def test_read_creates_one_default_session_under_contention():
    assert not sessions.session_path(DEFAULT).exists()
    with ThreadPoolExecutor(4) as pool:
        rows = list(pool.map(sessions.read, [DEFAULT] * 8))
    assert all(row == rows[0] for row in rows)
    assert rows[0].title == "默认会话"
    assert sessions.read(DEFAULT) == rows[0]


def test_first_list_creates_default_and_keeps_it_first(client):
    assert not sessions.session_path(DEFAULT).exists()
    assert [row["session_id"] for row in client.get(BASE).json()["sessions"]] == [DEFAULT]
    first = sessions.create({})
    second = sessions.create({})
    rows = client.get(BASE).json()["sessions"]
    assert [row["session_id"] for row in rows] == [DEFAULT, second.session_id, first.session_id]


def test_unreadable_default_keeps_other_sessions_visible():
    ordinary = sessions.create({})
    path = sessions.session_path(DEFAULT)
    path.write_text("invalid JSON", encoding="utf-8")
    assert [row["session_id"] for row in sessions.summaries()] == [ordinary.session_id]
    assert path.read_text(encoding="utf-8") == "invalid JSON"


def test_patch_and_delete_default_session(client):
    response = client.patch(f"{BASE}/{DEFAULT}", json={"model": "local-model", "model_alias": "local"})
    assert response.status_code == 200
    row = response.json()
    assert sessions.read(DEFAULT).model == "local-model"
    for headers in ({}, {"If-Match": str(row["revision"])}):
        rejected = client.delete(f"{BASE}/{DEFAULT}", headers=headers)
        assert rejected.status_code == 400
        assert rejected.json()["detail"] == "默认会话不能删除"
    assert client.get(f"{BASE}/{DEFAULT}").json() == row
