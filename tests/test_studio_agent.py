import io
import json
import time
from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError

from character_workflow.lib import keys, studio_agent_sessions as store
from character_workflow.lib.jobs import list_jobs
from character_workflow.lib.schemas import Job
from character_workflow.lib.studio_agent import StudioWorkspace, media_path
from tests.fake_http_vendor import FakeVendor
from tests.local_client import LocalTestClient
from tests.test_llm_protocols_gemini_agent import _chat_tool, _chat_text
from viewer_server.server_app import build_app

BASE = "/api/studio/agent/sessions"


@pytest.fixture
def client(isolated_data_root):
    with LocalTestClient(
        base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist")
    ) as api:
        yield api


def settle(client, url):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        response = client.get(url)
        assert response.status_code == 200, response.text
        row = response.json()
        if row["status"] != "running":
            return row
        time.sleep(0.02)
    pytest.fail("Studio Agent 未结束回合")


@pytest.mark.parametrize("price,allowed", [(1, True), (11, False)])
def test_agent_turn_generates_or_waits_for_permission(client, monkeypatch, price, allowed):
    from viewer_server import studio_agent_routes

    scheduled = []

    async def schedule(jid):
        scheduled.append(jid)

    monkeypatch.setattr(studio_agent_routes, "_start_studio_job_task", schedule)
    with FakeVendor() as vendor:
        keys.write_keys_db(
            keys.KeysDB(
                keys=[
                    keys.KeySpec(
                        alias="local",
                        provider="custom",
                        base_url=vendor.url + "/v1",
                        access_key="fake",
                        created_at="test",
                        models=[
                            keys.ModelSpec(
                                id="gpt-test", name="Chat", modality="text", protocol="openai-chat"
                            ),
                            keys.ModelSpec(
                                id="gpt-image-1",
                                name="Image",
                                modality="image",
                                protocol="openai",
                                per_call_cny=price,
                            ),
                        ],
                    )
                ]
            )
        )
        data = {"model": "gpt-test", "model_alias": "local", "creation_mode": "image"}
        row = client.post(BASE, json=data).json()
        sid = row["session_id"]
        url = BASE + "/" + sid
        image = io.BytesIO()
        Image.new("RGB", (4, 4)).save(image, "PNG")
        attach = client.post(
            url + "/attachments", files={"file": ("参考.png", image.getvalue(), "image/png")}
        )
        assert attach.status_code == 201, attach.text
        aid = attach.json()["attachment_id"]
        args = {
            "kind": "image",
            "alias": "local",
            "model": "gpt-image-1",
            "prompt": "cat",
            "references": [{"media_ref": "upload:" + aid}],
        }
        vendor.on(
            "POST", "/v1/chat/completions", _chat_tool("run_generation", args), _chat_text("完成")
        )
        msg = {"client_message_id": "first", "text": "根据参考画图", "attachment_ids": [aid]}
        accepted = client.post(url + "/messages", json=msg)
        assert accepted.status_code == 202, accepted.text
        row = settle(client, url)
        if allowed:
            assert row["status"] == "idle", row
            jobs = list_jobs()
            assert len(jobs) == 1, store.read(sid).history
            job = jobs[0]
            assert scheduled == [job.job_id]
            assert job.namespace == "studio" and job.studio_agent_session_id == sid
            assert job.studio_agent_turn_id == row["turns"][0]["turn_id"]
            reference = Path(job.params.reference_images[0])
            assert reference.parent.name == "uploads" and reference.parent.parent.name == ".runtime"
            with pytest.raises(ValidationError):
                Job.model_validate(job.model_dump() | {"namespace": "canvas"})
            old = job.model_dump(exclude={"studio_agent_session_id", "studio_agent_turn_id"})
            assert Job.model_validate(old).studio_agent_session_id is None
            forbidden = StudioWorkspace(sid, scheduled.append)
            forbidden.read()
            from character_workflow.lib.canvas_agent_runtime import ModelScope

            out = forbidden.invoke_sync(
                "run_generation", args | {"kind": "video"}, ModelScope("image"), "second"
            )
            assert "不允许" in out and len(list_jobs()) == 1
        else:
            assert row["status"] == "awaiting_approval", row
            assert not list_jobs()
            [decision] = row["pending_approvals"]
            accepted = client.post(
                url + "/approvals",
                json={"decisions": [{"call_id": decision["call_id"], "approve": False}]},
            )
            assert accepted.status_code == 202, accepted.text
            row = settle(client, url)
            assert row["status"] == "idle" and not list_jobs()
        assert "data:image/" not in json.dumps(store.read(sid).history)
        visible = [session["session_id"] for session in client.get(BASE).json()["sessions"]]
        assert visible == [store.DEFAULT_SESSION_ID, sid]
        assert len(client.post(url + "/messages", json=msg).json()["turns"]) == 1
        assert len(vendor.calls("POST", "/v1/chat/completions")) == 2
        assert client.delete(url, headers={"If-Match": str(row["revision"])}).status_code == 204
        assert client.get(url).status_code == 404
        if allowed:
            assert reference.read_bytes() == image.getvalue()


def test_attachment_scope(client):
    first, second = (client.post(BASE, json={}).json()["session_id"] for _ in range(2))
    with pytest.raises(ValueError):
        media_path(first, "upload:../other.png")
    assert client.get(f"{BASE}/{second}/attachments/nonexistent").status_code == 404
