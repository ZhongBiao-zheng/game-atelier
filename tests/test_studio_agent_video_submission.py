import json

import pytest

from character_workflow.lib import http_protocols, keys, studio_agent, studio_agent_sessions
from character_workflow.lib.canvas_agent_runtime import ALL_MODELS
from character_workflow.lib.job_runner import run_job
from character_workflow.lib.jobs import list_jobs
from tests.fake_http_vendor import MP4
from tests.test_declarative_caller import VIDEO as VIDEO_TEMPLATE
from tests.test_llm_protocols_gemini_agent import (
    GEMINI,
    _chat_text,
    _chat_tool,
    _gem,
    _gem_path,
    _gem_text,
)
from tests.test_studio_agent import settle
from tests.test_studio_agent_tools import CHAT, VIDEO, send, studio as studio


def add_video_channel(vendor, protocol, alias):
    spec = keys.ModelSpec(
        id="kling-v2", name="Video", modality="video", protocol=protocol, per_call_cny=4
    )
    if protocol == "declarative":
        stored = http_protocols.save_protocol(VIDEO_TEMPLATE)
        spec = spec.model_copy(update={"declarative_id": stored.id})
    keys.add_key(
        keys.KeySpec(
            alias=alias,
            provider="custom",
            base_url=vendor.url,
            models=[spec],
            access_key="fake",
            created_at="test",
        )
    )
    return spec


def video_upstream(vendor, protocol, count):
    vendor.on("GET", "/result.mp4", MP4)
    if protocol == "declarative":
        path = "/v1/videos"
        vendor.on("POST", path, {"id": "result"})
        vendor.on(
            "GET",
            path + "/result",
            {"status": "completed", "video_url": vendor.url + "/result.mp4"},
        )
    else:
        path = "/kling/v1/videos/text2video"
        vendor.on("POST", path, *[{"data": {"task_id": str(i)}} for i in range(count)])
        for i in range(count):
            vendor.on(
                "GET",
                path + "/" + str(i),
                {
                    "data": {
                        "task_status": "succeed",
                        "task_result": {"videos": [{"url": vendor.url + "/result.mp4"}]},
                    }
                },
            )
    return path


@pytest.mark.parametrize("protocol,count", [("kling", 3), ("declarative", 1)])
@pytest.mark.parametrize("auto", [False, True])
def test_video_quote_matches_real_vendor_submissions(studio, monkeypatch, protocol, count, auto):
    from character_workflow.lib.callers import video_poll

    poll = video_poll.poll_responses
    monkeypatch.setattr(
        video_poll, "poll_responses", lambda **kwargs: poll(**(kwargs | {"poll_interval": 0}))
    )
    api, url, vendor, _ = studio
    spec = add_video_channel(vendor, protocol, "video")
    if protocol == "declarative":
        copy = keys.find_by_alias("video").model_copy(update={"alias": "video-copy"})
        keys.add_key(copy)
    item = VIDEO | {"count": count, "alias": "video"}
    if auto:
        from character_workflow.lib.model_routes import route_id

        item.update(alias=None, model=route_id(spec, keys.find_by_alias("video")))
    sid = url.rsplit("/", 1)[1]
    ws = studio_agent.StudioWorkspace(sid, lambda _jid: None)
    rows = ws.execute("list_models", {"mode": "video"}, ALL_MODELS, "list", frozenset())["models"]
    model = next(r for r in rows if r["alias"] == item["alias"] and r["model"] == item["model"])
    assert model["capabilities"]["count"]["max"] == (1 if protocol == "declarative" else 4)
    path = video_upstream(vendor, protocol, count)
    assert api.patch(url, json={"permission_mode": "review"}).status_code == 200
    send(api, url, vendor, "run_generations", {"items": [item]})
    [approval] = settle(api, url)["pending_approvals"]
    call_id = approval["call_id"]
    [quote] = api.get(url + f"/approvals/{call_id}/items").json()["items"]
    assert not list_jobs() and not vendor.calls("POST", path)
    assert (
        api.post(
            url + "/approvals", json={"decisions": [{"call_id": call_id, "approve": True}]}
        ).status_code
        == 202
    )
    assert settle(api, url)["status"] == "idle"
    [job] = list_jobs()
    assert job.params.n == count
    done = run_job(job.job_id)
    assert done.status.value == "done", done.error
    submitted = len(vendor.calls("POST", path))
    assert submitted == len(done.output_paths) == quote["count"] == count
    assert quote["estimate_cny"] == 4 * submitted


def test_single_video_protocol_rejects_excess_before_confirmation(studio):
    api, url, vendor, _ = studio
    add_video_channel(vendor, "declarative", "single")
    send(
        api,
        url,
        vendor,
        "run_generations",
        {"items": [VIDEO, VIDEO | {"alias": "single", "count": 4}]},
    )
    row = settle(api, url)
    assert row["status"] == "idle" and not row["pending_approvals"] and not list_jobs()
    assert not vendor.calls("POST", "/v1/videos")
    assert "最多生成 1 条" in row["turns"][0]["steps"][0]["summary"]


def test_reused_call_id_new_parameters_need_new_approval_but_reentry_deduplicates(studio):
    api, url, vendor, _ = studio
    # 上游复用 call_chat1。第一次重放改变默认值写法、参数类型及顺序；第二次在裁决后重放。
    first = VIDEO | {"count": 1, "params": {"ratio": "16:9", "duration": 5}}
    replay = VIDEO | {"params": {"duration": "5", "ratio": "16:9"}}
    next_order = first | {"count": 3}
    vendor.on(
        "POST",
        CHAT,
        _chat_tool("run_generation", first),
        _chat_tool("run_generation", replay),
        _chat_tool("run_generation", next_order),
        _chat_tool("run_generation", next_order),
        _chat_text("完成"),
    )
    assert (
        api.post(
            url + "/messages", json={"client_message_id": "same-id", "text": "生成两种视频"}
        ).status_code
        == 202
    )
    waiting = settle(api, url)
    [prior] = list_jobs()
    [approval] = waiting["pending_approvals"]
    assert prior.params.n == 1 and "12 元" in approval["summary"]
    assert (
        api.post(
            url + "/approvals",
            json={"decisions": [{"call_id": approval["call_id"], "approve": True}]},
        ).status_code
        == 202
    )
    row = settle(api, url)
    assert row["status"] == "idle"
    jobs = list_jobs()
    assert sorted(job.params.n for job in jobs) == [1, 3]
    assert len({job.job_id for job in jobs}) == 2
    history = studio_agent_sessions.read(row["session_id"]).history
    outputs = [
        json.loads(item["output"]) for item in history if item.get("type") == "function_call_output"
    ]
    next_id = next(job.job_id for job in jobs if job.params.n == 3)
    assert [output["job_id"] for output in outputs] == [prior.job_id, next_id, next_id]
    outgoing = vendor.calls("POST", CHAT)[-1].json()["messages"]
    # SDK 去掉了已完成的等参重放。送到厂商的两笔订单分别带着其原始 id 和对应结果。
    calls = [call for msg in outgoing for call in msg.get("tool_calls", [])]
    results = [msg for msg in outgoing if msg["role"] == "tool"]
    assert (
        [call["id"] for call in calls]
        == [m["tool_call_id"] for m in results]
        == ["call_chat1", "call_chat1"]
    )
    assert [json.loads(call["function"]["arguments"])["count"] for call in calls] == [1, 3]
    assert [json.loads(m["content"])["job_id"] for m in results] == [prior.job_id, next_id]


def test_changed_batch_creates_one_whole_new_order_at_the_new_quote(studio):
    api, url, vendor, _ = studio
    first = {"items": [VIDEO, VIDEO | {"prompt": "street"}]}
    second = {"items": [VIDEO, VIDEO | {"prompt": "forest", "count": 3}]}
    vendor.on(
        "POST",
        CHAT,
        _chat_tool("run_generations", first),
        _chat_tool("run_generations", second),
        _chat_text(),
    )
    assert api.post(
        url + "/messages", json={"client_message_id": "batch", "text": "生成"}
    ).is_success
    [approval] = settle(api, url)["pending_approvals"]
    click = approval["call_id"]
    quotes = api.get(url + f"/approvals/{click}/items").json()["items"]
    prior = {job.job_id for job in list_jobs()}
    assert len(prior) == 2
    assert api.post(
        url + "/approvals", json={"decisions": [{"call_id": click, "approve": True}]}
    ).is_success
    assert settle(api, url)["status"] == "idle"
    new_jobs = [job for job in list_jobs() if job.job_id not in prior]
    assert sorted((job.prompt, job.params.n) for job in new_jobs) == [("cat", 1), ("forest", 3)]
    assert sum(q["estimate_cny"] for q in quotes) == sum(job.params.n * 4 for job in new_jobs)


def test_gemini_reused_id_preserves_each_original_signed_call_and_result(studio):
    api, url, vendor, _ = studio
    keys.add_key(
        keys.KeySpec(
            alias="gem",
            provider="custom",
            base_url=vendor.url,
            access_key="fake",
            created_at="test",
            text_protocol="gemini-generate-content",
            models=[
                keys.ModelSpec(
                    id=GEMINI, name=GEMINI, modality="text", protocol="gemini-generate-content"
                )
            ],
        )
    )
    assert api.patch(url, json={"model_alias": "gem", "model": GEMINI}).is_success

    def command(n):
        call = {"id": "same-id", "name": "run_generation", "args": VIDEO | {"count": n}}
        part = {"functionCall": call, "thoughtSignature": f"signature-{n}"}
        return _gem(
            {
                "candidates": [
                    {"content": {"role": "model", "parts": [part]}, "finishReason": "STOP"}
                ]
            }
        )

    vendor.on("POST", _gem_path(), command(1), command(3), _gem_text())
    assert api.post(url + "/messages", json={"client_message_id": "gem", "text": "生成"}).is_success
    [approval] = settle(api, url)["pending_approvals"]
    assert api.post(
        url + "/approvals", json={"decisions": [{"call_id": approval["call_id"], "approve": True}]}
    ).is_success
    assert settle(api, url)["status"] == "idle"
    parts = [
        p for row in vendor.calls("POST", _gem_path())[-1].json()["contents"] for p in row["parts"]
    ]
    assert [
        (p["functionCall"]["id"], p["thoughtSignature"]) for p in parts if "functionCall" in p
    ] == [("same-id", "signature-1"), ("same-id", "signature-3")]
    assert [p["functionResponse"]["id"] for p in parts if "functionResponse" in p] == [
        "same-id",
        "same-id",
    ]
