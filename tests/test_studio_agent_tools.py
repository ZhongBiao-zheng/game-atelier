import asyncio
import base64
import json
import threading
from datetime import datetime

import pytest

from character_workflow.lib import canvas_agent_cost as cost, keys, studio_agent
from character_workflow.lib.jobs import list_jobs
from tests.fake_http_vendor import FakeVendor, png_bytes
from tests.local_client import LocalTestClient
from tests.test_llm_protocols_gemini_agent import _chat, _chat_text, _chat_tool
from tests.test_studio_agent import BASE, settle
from viewer_server import routes, studio_agent_routes
from viewer_server.server_app import build_app

CHAT = "/v1/chat/completions"
IMAGE = {"kind": "image", "model": "gpt-image-1", "alias": "local", "prompt": "cat"}
VIDEO = {"kind": "video", "model": "kling-v2", "alias": "local", "prompt": "cat"}


@pytest.fixture
def studio(isolated_data_root, monkeypatch):
    async def schedule(jid):
        pass

    events = []
    monkeypatch.setattr(studio_agent_routes, "_start_studio_job_task", schedule)
    monkeypatch.setattr(
        studio_agent_routes.hub, "broadcast", lambda name, data: events.append(data)
    )
    with (
        FakeVendor() as vendor,
        LocalTestClient(
            base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist")
        ) as api,
    ):
        models = [
            keys.ModelSpec(id="gpt-test", name="Chat", modality="text", protocol="openai-chat"),
            keys.ModelSpec(id="gpt-image-1", name="Image", modality="image", protocol="openai"),
            keys.ModelSpec(
                id="kling-v2", name="Video", modality="video", protocol="kling", per_call_cny=4
            ),
        ]
        keys.write_keys_db(
            keys.KeysDB(
                keys=[
                    keys.KeySpec(
                        alias="local",
                        provider="custom",
                        base_url=vendor.url + "/v1",
                        access_key="fake",
                        created_at="test",
                        models=models,
                    )
                ]
            )
        )
        created = api.post(BASE, json={"model": "gpt-test", "model_alias": "local"})
        assert created.status_code == 201
        yield api, BASE + "/" + created.json()["session_id"], vendor, events


def send(api, url, vendor, tool, args):
    vendor.on("POST", CHAT, _chat_tool(tool, args), _chat_text("完成"))
    response = api.post(url + "/messages", json={"client_message_id": "first", "text": "执行创作"})
    assert response.status_code == 202


def test_video_total_needs_approval_and_rejection_survives_reload(studio):
    api, url, vendor, events = studio
    args = {"items": [VIDEO | {"count": 3, "prompt": "参考 /not-public/media/a.jpg"}]}
    send(api, url, vendor, "run_generations", args)
    waiting = settle(api, url)
    assert waiting["status"] == "awaiting_approval"
    [approval] = waiting["pending_approvals"]
    assert "arguments" not in approval and "12 元" in approval["summary"]
    assert "/not-public" not in json.dumps(waiting)
    call_id = approval["call_id"]
    items = api.get(url + f"/approvals/{call_id}/items").json()["items"]
    assert items[0]["estimate_cny"] == 12 and "/not-public" not in items[0]["title"]
    assert (
        api.post(
            url + "/approvals", json={"decisions": [{"call_id": call_id, "approve": False}]}
        ).status_code
        == 202
    )
    final = settle(api, url)
    assert final["status"] == "idle" and not list_jobs()
    [step] = final["turns"][0]["steps"]
    assert step["step_id"] == call_id and step["status"] == "rejected"
    assert [e["step"]["status"] for e in events if e.get("kind") == "step"] == [
        "running",
        "rejected",
    ]
    assert "/not-public" not in json.dumps(final)


@pytest.mark.parametrize("price", [None, 10])
def test_unknown_or_threshold_price_auto_submits(studio, monkeypatch, price):
    api, url, vendor, _ = studio
    monkeypatch.setattr(cost, "_estimate", lambda *args: price)
    send(api, url, vendor, "run_generation", IMAGE)
    row = settle(api, url)
    assert row["status"] == "idle" and len(list_jobs()) == 1
    assert row["turns"][0]["steps"][0]["status"] == "completed"


def test_reference_affects_estimate(studio, monkeypatch):
    api, url, vendor, _ = studio
    aid = api.post(
        url + "/attachments", files={"file": ("ref.png", png_bytes(), "image/png")}
    ).json()["attachment_id"]
    seen = []

    def price(kind, alias, model, params):
        seen.append(params)
        return 6 if params.get("reference_images") else 1

    monkeypatch.setattr(cost, "_estimate", price)
    send(
        api,
        url,
        vendor,
        "run_generation",
        VIDEO | {"count": 2, "references": [{"media_ref": "upload:" + aid, "slot": "first_frame"}]},
    )
    assert settle(api, url)["status"] == "awaiting_approval"
    assert seen and all(p["frame_mode"] == "first" and p["n"] == 1 for p in seen)
    assert not list_jobs()


@pytest.mark.parametrize(
    "bad",
    [
        {"params": {"gateway_request_id": "private-value"}},
        {"references": [{"media_ref": "upload:unregistered"}]},
        {"model": "outside-scope"},
    ],
)
def test_invalid_batch_cost_or_scope_does_not_submit_any_item(studio, bad):
    api, url, vendor, _ = studio
    send(api, url, vendor, "run_generations", {"items": [IMAGE, IMAGE | bad]})
    final = settle(api, url)
    assert final["status"] == "idle" and not list_jobs()
    [step] = final["turns"][0]["steps"]
    assert step["status"] == "failed"
    assert "private-value" not in json.dumps(final)


def test_batch_partial_approval_and_runtime_failure_preserve_submitted_job(studio, monkeypatch):
    api, url, vendor, _ = studio
    original = routes._create_user_job

    def create(body, **kwargs):
        if body.prompt == "fails":
            raise OSError("/private/path/tmp")
        return original(body, **kwargs)

    monkeypatch.setattr(routes, "_create_user_job", create)
    assert api.patch(url, json={"permission_mode": "review"}).status_code == 200
    args = {"items": [IMAGE | {"prompt": text} for text in ("success", "skipped", "fails")]}
    send(api, url, vendor, "run_generations", args)
    [approval] = settle(api, url)["pending_approvals"]
    decisions = [{"approve": True, "items": [0, 2], "call_id": approval["call_id"]}]
    assert api.post(url + "/approvals", json={"decisions": decisions}).status_code == 202
    final = settle(api, url)
    [job] = list_jobs()
    assert job.prompt == "success"
    [step] = final["turns"][0]["steps"]
    assert step["status"] == "failed" and step["summary"] == "已提交 1 项，已拒绝 1 项，失败 1 项"
    assert "/private/path" not in json.dumps(final)
    assert api.post(url + "/approvals", json={"decisions": decisions}).status_code == 409


def test_stop_marks_live_sdk_tool_and_preserves_step_id(studio, monkeypatch):
    api, url, vendor, events = studio
    started = threading.Event()

    async def wait(_self, _ids):
        started.set()
        await asyncio.Future()

    monkeypatch.setattr(studio_agent.StudioWorkspace, "wait", wait)
    send(api, url, vendor, "wait_for_run", {"job_id": "studio-pending"})
    assert started.wait(4)
    [active] = api.get(url).json()["turns"][0]["steps"]
    assert active["status"] == "running" and active["tool"] == "wait_for_run"
    assert api.post(url + "/cancel").status_code == 200
    row = api.get(url).json()
    [stopped] = row["turns"][0]["steps"]
    assert row["status"] == "interrupted" and stopped["status"] == "interrupted"
    assert active["step_id"] == stopped["step_id"]
    assert [e["step"]["status"] for e in events if e.get("kind") == "step"] == [
        "running",
        "interrupted",
    ]


def test_model_failure_records_model_step(studio):
    api, url, vendor, _ = studio
    vendor.on("POST", CHAT, (400, {"error": {"message": "fake model error"}}))
    assert (
        api.post(
            url + "/messages", json={"client_message_id": "model", "text": "试图生成"}
        ).status_code
        == 202
    )
    row = settle(api, url)
    [step] = row["turns"][0]["steps"]
    assert row["status"] == "failed" and step["tool"] == "model" and step["status"] == "failed"
    assert "fake model error" in step["summary"]


@pytest.mark.parametrize("count", [20, 21])
def test_batch_limit_through_sdk(studio, count):
    api, url, vendor, _ = studio
    api.patch(url, json={"permission_mode": "review"})
    send(api, url, vendor, "run_generations", {"items": [IMAGE] * count})
    row = settle(api, url)
    if count == 20:
        assert row["status"] == "awaiting_approval"
        call_id = row["pending_approvals"][0]["call_id"]
        assert len(api.get(url + f"/approvals/{call_id}/items").json()["items"]) == 20
    else:
        assert row["status"] == "idle" and row["turns"][0]["steps"][0]["status"] == "failed"
    assert not list_jobs()


def test_real_studio_runner_returns_image_to_followup_model(studio, monkeypatch):
    api, url, vendor, _ = studio
    monkeypatch.setattr(
        studio_agent_routes, "_start_studio_job_task", routes._start_studio_job_task
    )
    monkeypatch.setattr(studio_agent.vision, "POLL_SECONDS", 0.03)
    vendor.on(
        "POST",
        "/v1/images/generations",
        {"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]},
    )
    send(api, url, vendor, "run_generation", IMAGE)
    assert settle(api, url)["status"] == "idle"
    [job] = list_jobs()
    vendor.on(
        "POST", CHAT, _chat_tool("wait_for_run", {"job_id": job.job_id}), _chat_text("看到结果了")
    )
    response = api.post(
        url + "/messages", json={"client_message_id": "check", "text": "查看上轮图片"}
    )
    assert response.status_code == 202
    assert settle(api, url)["status"] == "idle"
    [job] = list_jobs()
    assert job.status.value == "done", job.error
    assert len(vendor.calls("POST", "/v1/images/generations")) == 1
    messages = vendor.calls("POST", CHAT)[-1].json()["messages"]
    assert any(
        part.get("type") == "image_url" and part["image_url"]["url"].startswith("data:image/")
        for message in messages
        if isinstance(message.get("content"), list)
        for part in message["content"]
    )
    assert "data:image/" not in json.dumps(
        studio_agent.sessions.read(job.studio_agent_session_id).history
    )


@pytest.mark.parametrize("review", [False, True])
def test_reply_timestamps_follow_each_model_response_and_submission(studio, review):
    api, url, vendor, _ = studio
    if review:
        api.patch(url, json={"permission_mode": "review"})
    # 同一 SDK 响应可以同时包含工具前的说明和调用。第二次响应重复相同正文，
    # 验证时间跟随实际回复，重载及审批续跑都不会把两条消息混为同一条。
    text = "这是当前进度"
    delta = {
        "role": "assistant",
        "content": text,
        "tool_calls": [
            {
                "index": 0,
                "id": "call-create",
                "type": "function",
                "function": {"name": "run_generation", "arguments": json.dumps(IMAGE)},
            }
        ],
    }
    first = _chat(
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "gpt-test",
            "choices": [{"index": 0, "delta": delta, "finish_reason": "tool_calls"}],
        }
    )
    vendor.on("POST", CHAT, first, _chat_text(text))
    response = api.post(
        url + "/messages", json={"client_message_id": "first", "text": "生成一张图"}
    )
    assert response.status_code == 202
    row = settle(api, url)
    if review:
        [approval] = row["pending_approvals"]
        assert (
            api.post(
                url + "/approvals",
                json={"decisions": [{"call_id": approval["call_id"], "approve": True}]},
            ).status_code
            == 202
        )
        row = settle(api, url)
    assert row["status"] == "idle"
    row = api.get(url).json()
    [before, after] = [m for m in row["messages"] if m["role"] == "assistant"]
    [job] = list_jobs()
    assert before["text"] == after["text"] == text
    assert before["turn_id"] == job.studio_agent_turn_id == after["turn_id"]
    assert (
        datetime.fromisoformat(before["created_at"])
        < datetime.fromisoformat(job.submitted_at)
        < datetime.fromisoformat(after["created_at"])
    )
