"""Project-scoped Canvas Agent session persistence."""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.canvas_agent_sessions import (
    append_canvas_agent_message,
    read_canvas_agent_session,
)
from character_workflow.lib.canvas_packages import (
    CanvasPackageError,
    commit_canvas_package,
    export_canvas_projects,
    inspect_canvas_package,
)
from character_workflow.lib.canvas_projects import canvas_project_dir, canvas_project_lock_path
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasAgentMessageCreate,
    CanvasAgentReference,
    CanvasAgentSession,
)
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app(dist_dir=isolated_data_root / "dist"))


def _create_project(client: TestClient) -> str:
    response = client.post("/api/canvas/projects", json={"name": "Agent 分镜"})
    assert response.status_code == 201, response.json()
    return response.json()["project_id"]


def _create_session(client: TestClient, project_id: str, title: str = "雨夜列车") -> dict:
    response = client.post(
        f"/api/canvas/projects/{project_id}/agent/sessions",
        json={"title": title},
    )
    assert response.status_code == 201, response.json()
    return response.json()


def test_agent_session_api_is_project_scoped_and_revision_safe(client, isolated_data_root):
    project_id = _create_project(client)
    sessions_dir = isolated_data_root / "canvases" / project_id / "agent" / "sessions"
    assert sessions_dir.is_dir()

    sessions_dir.rmdir()
    sessions_dir.parent.rmdir()
    empty_existing = client.get(f"/api/canvas/projects/{project_id}/agent/sessions")
    assert empty_existing.status_code == 200
    assert empty_existing.json() == {"sessions": [], "corrupt_session_ids": []}
    assert not sessions_dir.exists()

    created = _create_session(client, project_id)
    assert sessions_dir.is_dir()
    session_id = created["session_id"]
    assert created == {
        "schema_version": 1,
        "revision": 0,
        "sequence": 0,
        "session_id": session_id,
        "project_id": project_id,
        "title": "雨夜列车",
        "status": "idle",
        "model": None,
        "effort": None,
        "token_usage": {"input_tokens": 0, "output_tokens": 0},
        "messages": [],
        "created_at": created["created_at"],
        "updated_at": created["updated_at"],
    }

    listed = client.get(f"/api/canvas/projects/{project_id}/agent/sessions")
    assert listed.status_code == 200
    assert listed.json() == {
        "sessions": [{
            "session_id": session_id,
            "project_id": project_id,
            "title": "雨夜列车",
            "status": "idle",
            "revision": 0,
            "sequence": 0,
            "message_count": 0,
            "created_at": created["created_at"],
            "updated_at": created["updated_at"],
        }],
        "corrupt_session_ids": [],
    }

    loaded = client.get(f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}")
    assert loaded.status_code == 200
    assert loaded.headers["etag"] == '"0"'
    assert loaded.json() == created

    missing_match = client.delete(
        f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}"
    )
    assert missing_match.status_code == 428
    assert sessions_dir.joinpath(f"{session_id}.json").is_file()

    append_canvas_agent_message(
        project_id,
        session_id,
        CanvasAgentMessageCreate(role="user", text="这条消息让 revision 前进"),
        expected_revision=0,
    )
    stale = client.delete(
        f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}",
        headers={"If-Match": "0"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == {"code": "revision_conflict", "current_revision": 1}
    assert sessions_dir.joinpath(f"{session_id}.json").is_file()

    wrong_project = _create_project(client)
    assert client.get(
        f"/api/canvas/projects/{wrong_project}/agent/sessions/{session_id}"
    ).status_code == 404

    deleted = client.delete(
        f"/api/canvas/projects/{project_id}/agent/sessions/{session_id}",
        headers={"If-Match": "1"},
    )
    assert deleted.status_code == 204
    assert not sessions_dir.joinpath(f"{session_id}.json").exists()


def test_invalid_agent_session_id_creates_no_lock_file(client, isolated_data_root):
    project_id = _create_project(client)
    locks_root = isolated_data_root / ".runtime" / "locks"
    before = set(locks_root.rglob("*")) if locks_root.exists() else set()

    with pytest.raises(KeyError):
        read_canvas_agent_session(project_id, r"..\escaped")

    after = set(locks_root.rglob("*")) if locks_root.exists() else set()
    assert after == before


def test_agent_message_append_is_atomic_and_corrupt_session_is_isolated(
    client,
    isolated_data_root,
):
    project_id = _create_project(client)
    healthy = _create_session(client, project_id, "健康会话")
    corrupt = _create_session(client, project_id, "损坏会话")

    updated = append_canvas_agent_message(
        project_id,
        healthy["session_id"],
        CanvasAgentMessageCreate(
            role="user",
            text="请把图片节点放到文本右侧",
            references=[],
        ),
        expected_revision=0,
    )
    assert updated.revision == 1
    assert updated.sequence == 1
    assert updated.messages[0].sequence == 1
    assert updated.messages[0].role == "user"
    assert read_canvas_agent_session(project_id, healthy["session_id"]) == updated
    with pytest.raises(RuntimeError, match="revision_conflict:1"):
        append_canvas_agent_message(
            project_id,
            healthy["session_id"],
            CanvasAgentMessageCreate(role="assistant", text="已准备变更提案"),
            expected_revision=0,
        )

    corrupt_path = (
        isolated_data_root
        / "canvases"
        / project_id
        / "agent"
        / "sessions"
        / f"{corrupt['session_id']}.json"
    )
    corrupt_path.write_text("{not-json", encoding="utf-8")

    listed = client.get(f"/api/canvas/projects/{project_id}/agent/sessions")
    assert listed.status_code == 200
    assert [row["session_id"] for row in listed.json()["sessions"]] == [
        healthy["session_id"]
    ]
    assert listed.json()["corrupt_session_ids"] == [corrupt["session_id"]]

    broken = client.get(
        f"/api/canvas/projects/{project_id}/agent/sessions/{corrupt['session_id']}"
    )
    assert broken.status_code == 409
    assert broken.json()["detail"] == (
        "Agent 会话状态损坏，该文件已隔离；请从项目包恢复"
    )

    corrupt_path.write_bytes(b"\xff\xfe\x00\x80")
    binary_listed = client.get(f"/api/canvas/projects/{project_id}/agent/sessions")
    assert binary_listed.status_code == 200
    assert [row["session_id"] for row in binary_listed.json()["sessions"]] == [
        healthy["session_id"]
    ]
    assert binary_listed.json()["corrupt_session_ids"] == [corrupt["session_id"]]


def test_concurrent_agent_message_append_has_one_winner(client):
    project_id = _create_project(client)
    session_id = _create_session(client, project_id)["session_id"]
    barrier = threading.Barrier(2)

    def append(text: str):
        barrier.wait()
        try:
            return append_canvas_agent_message(
                project_id,
                session_id,
                CanvasAgentMessageCreate(role="user", text=text),
                expected_revision=0,
            )
        except RuntimeError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(append, ["第一条", "第二条"]))

    sessions = [result for result in results if not isinstance(result, RuntimeError)]
    conflicts = [result for result in results if isinstance(result, RuntimeError)]
    assert len(sessions) == 1
    assert len(conflicts) == 1
    assert str(conflicts[0]) == "revision_conflict:1"
    stored = read_canvas_agent_session(project_id, session_id)
    assert stored.revision == 1
    assert stored.sequence == 1
    assert len(stored.messages) == 1


def test_agent_message_append_does_not_wait_for_canvas_document_lock(client):
    project_id = _create_project(client)
    session_id = _create_session(client, project_id)["session_id"]

    with ThreadPoolExecutor(max_workers=1) as pool:
        with file_lock(canvas_project_lock_path(project_id)):
            result = pool.submit(
                append_canvas_agent_message,
                project_id,
                session_id,
                CanvasAgentMessageCreate(role="user", text="独立冷域写入"),
                0,
            ).result(timeout=1)

    assert result.revision == 1
    assert result.messages[0].text == "独立冷域写入"


def test_agent_session_roundtrips_through_project_package(client):
    project_id = _create_project(client)
    created = _create_session(client, project_id, "可移植会话")
    session_id = created["session_id"]
    stored = append_canvas_agent_message(
        project_id,
        session_id,
        CanvasAgentMessageCreate(role="assistant", text="项目包应保留这条历史"),
        expected_revision=0,
    )

    package_path, _filename = export_canvas_projects([project_id])
    try:
        inspection = inspect_canvas_package(package_path)
    finally:
        package_path.unlink(missing_ok=True)
    imported = commit_canvas_package(inspection.token)
    assert len(imported) == 1
    imported_project_id = imported[0].project_id
    assert imported_project_id != project_id

    restored = read_canvas_agent_session(imported_project_id, session_id)
    assert restored.project_id == imported_project_id
    assert restored.session_id == session_id
    assert restored.revision == stored.revision
    assert restored.sequence == stored.sequence
    assert [message.message_id for message in restored.messages] == [
        stored.messages[0].message_id
    ]
    assert restored.messages[0].text == "项目包应保留这条历史"


def test_agent_session_schema_rejects_paths_and_unregistered_fields(client):
    project_id = _create_project(client)
    created = _create_session(client, project_id)

    session_path = (
        read_canvas_agent_session(project_id, created["session_id"])
        .model_copy(update={"messages": []})
        .model_dump(mode="json")
    )
    session_path["token"] = "secret"
    raw = json.dumps(session_path)
    with pytest.raises(ValueError):
        CanvasAgentSession.model_validate_json(raw)

    private_values = [
        "/Users/example/private.png",
        "/var/folders/cache/private.png",
        "/tmp/private.png",
        "/Volumes/team/private.png",
        "~/private/notes.txt",
        "../private/notes.txt",
        "assets/private/notes.png",
        r"C:\\private\\notes.txt",
        r"\\\\server\\share\\notes.txt",
        "Bearer abcdefghijklmnop",
        "OPENAI_API_KEY=do-not-store",
        "api_key: do-not-store",
        "sk-abcdefghijklmnop",
    ]
    for private_value in private_values:
        with pytest.raises(ValueError, match="cannot persist"):
            CanvasAgentMessageCreate(role="user", text=private_value)

    with pytest.raises(ValueError, match="cannot persist"):
        CanvasAgentReference(
            reference_id="node-private",
            kind="node",
            node_id="node-safe",
            title="/tmp/private.png",
        )

    mismatched_id = dict(session_path)
    mismatched_id.pop("token")
    mismatch_path = (
        canvas_project_dir(project_id)
        / "agent"
        / "sessions"
        / "session-deadbeef.json"
    )
    mismatch_path.write_text(json.dumps(mismatched_id), encoding="utf-8")
    with pytest.raises(CanvasPackageError, match="Agent Session 归属或文件名不一致"):
        export_canvas_projects([project_id])
