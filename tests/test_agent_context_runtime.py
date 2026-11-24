"""Check both sides of the SDK request filter using a loopback chat endpoint."""
import json

import pytest

from character_workflow.lib import canvas_agent_runtime as runtime, keys, studio_agent_sessions
from character_workflow.lib.canvas_agent_schema import ImportMediaInput
from tests.fake_http_vendor import FakeVendor, png_bytes
from tests.local_client import LocalTestClient
from tests.test_canvas_agent_runtime import _session
from tests.test_llm_protocols_gemini_agent import _chat_text, _chat_tool
from tests.test_studio_agent import BASE, settle
from viewer_server.server_app import build_app

CHAT = "/v1/chat/completions"


@pytest.fixture
def local_chat(isolated_data_root):
    with FakeVendor() as vendor, LocalTestClient(
        base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist")
    ) as api:
        keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
            alias="local", provider="custom", base_url=vendor.url + "/v1",
            access_key="fake", created_at="test", models=[keys.ModelSpec(
                id="gpt-test", name="Chat", modality="text", protocol="openai-chat")],
        )]))
        yield api, vendor


@pytest.mark.parametrize("workspace", ["canvas", "studio"])
def test_user_and_tool_images_reach_model_but_only_refs_are_saved(
    local_chat, isolated_data_root, workspace
):
    api, vendor = local_chat
    model = {"model": "gpt-test", "model_alias": "local"}
    message = {"text": "查看参考"}
    if workspace == "canvas":
        project, sid, url = _session(api)
        assert api.patch(url, json=model).status_code == 200
        path = isolated_data_root / "ref.png"
        path.write_bytes(png_bytes())
        node = runtime.tools.import_media(runtime.LOCAL, ImportMediaInput(
            project_id=project, expected_revision=0, path=str(path), title="参考"))
        ref = node["version_id"]
        args = {"version_id": ref}
        message["node_ids"] = [node["node_id"]]
        def read():
            return runtime.read_canvas_agent_session(project, sid)
    else:
        sid = api.post(BASE, json=model).json()["session_id"]
        url = f"{BASE}/{sid}"
        upload = api.post(url + "/attachments", files={"file": ("ref.png", png_bytes(), "image/png")})
        assert upload.status_code == 201
        aid = upload.json()["attachment_id"]
        ref = "upload:" + aid
        args = {"media_ref": ref}
        message.update(client_message_id="first", attachment_ids=[aid])
        def read():
            return studio_agent_sessions.read(sid)

    vendor.on("POST", CHAT, _chat_tool("read_media", args), _chat_text("看到了"))
    assert api.post(url + "/messages", json=message).status_code == 202
    assert settle(api, url)["status"] == "idle"
    requests = vendor.calls("POST", CHAT)
    assert [json.dumps(request.json()["messages"]).count("data:image/") for request in requests] == [1, 2]
    history = read().history
    assert "data:" not in json.dumps(history)
    assert [item["role"] for item in history if item.get("role") == "user"] == ["user"]
    assert history[0]["content"][-1]["image_url"] == "atelier-media://" + ref
    [output] = [item for item in history if item.get("type") == "function_call_output"]
    assert json.loads(output["output"])["attach_images"] == [ref]

    # Once the attachment ages out, read_media accepts the reference shown in the placeholder.
    for index in (2, 3):
        responses = [_chat_text("继续")] if index == 2 else [_chat_tool("read_media", args), _chat_text("看到了")]
        vendor.on("POST", CHAT, *responses)
        followup = {"text": "再看一遍"}
        if workspace == "studio":
            followup["client_message_id"] = str(index)
        assert api.post(url + "/messages", json=followup).status_code == 202
        assert settle(api, url)["status"] == "idle"
    last = vendor.calls("POST", CHAT)[-1].json()["messages"]
    assert f"[早期参考图已省略：media_ref={ref}，需要时调用 read_media]" in json.dumps(last, ensure_ascii=False)
    saved = read().history
    assert saved[:len(history)] == history
    outputs = [json.loads(item["output"]) for item in saved if item.get("type") == "function_call_output"]
    assert outputs[-1]["attach_images"] == [ref]
    assert "data:" not in json.dumps(saved)
