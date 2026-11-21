"""Gateway protocol selection, provider translation and member-visible settlement."""
import pytest
from pydantic import BaseModel

from character_workflow.lib import gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers.atelier_gateway import gateway_models
from character_workflow.lib.llm_protocols import detect
from viewer_server import gateway_openai
from viewer_server.gateway_app import _route_view


def member(alias, protocol, url="http://127.0.0.1:1", *, manual=None, model_id="shared"):
    key = keys.KeySpec(alias=alias, provider="custom", access_key="fixture-key", base_url=url,
                       text_protocol=manual, created_at="test", modalities=["llm"], models=[
                           keys.ModelSpec(id=model_id, name=model_id, modality="text", protocol=protocol)])
    keys.add_key(key)
    return key


@pytest.mark.parametrize("endpoint", ["chat/completions", "responses"])
@pytest.mark.parametrize("protocol", ["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate-content"])
def test_protocol_and_scope_filter(endpoint, protocol):
    member("denied", "openai-responses" if endpoint == "responses" else "openai-chat")
    member("allowed", protocol)
    owner, _ = gateway_keys.create_key("member", scope=[{"alias": "allowed"}])
    if (protocol == "openai-responses") == (endpoint == "responses"):
        assert gateway_openai._pick(owner, "shared", [], endpoint=endpoint)[0].alias == "allowed"
    else:
        with pytest.raises(gateway_tasks.GatewayRequestError):
            gateway_openai._pick(owner, "shared", [], endpoint=endpoint)


def test_snapshot_supports_old_members_old_hosts_and_agent_restriction():
    class OldMember(BaseModel):
        protocol: str

    member("resp", "openai-responses")
    member("gem", "gemini-generate-content")
    owner, _ = gateway_keys.create_key("member")
    route = model_routes.find_route("text", "shared")
    view = _route_view(route, owner)
    assert [OldMember(**m).protocol for m in view["members"]] == ["openai-chat"] * 2
    assert {m["upstream_protocol"] for m in view["members"]} == {"openai-responses", "gemini-generate-content"}
    [model] = gateway_models([view])
    hub = keys.KeySpec(alias="Hub", provider="atelier", access_key="fixture-key", created_at="test")
    assert detect.agent_tools_unverified(hub, model)
    owner = gateway_keys.update_key(owner.id, scope=[{"alias": "resp"}])
    only = _route_view(route, owner)
    assert only["members"][0]["protocol"] == "openai-responses"
    only["members"][0].pop("upstream_protocol")
    [old] = gateway_models([only])
    assert old.protocol == "openai-responses" and old.via[0].upstream_protocol is None
    assert not detect.agent_tools_unverified(hub, old)


@pytest.fixture
def gateway(monkeypatch):
    from fastapi.testclient import TestClient
    from tests.fake_http_vendor import FakeVendor
    from viewer_server.gateway_app import create_gateway_app

    monkeypatch.setenv("no_proxy", "*")
    _, token = gateway_keys.create_key("member")
    with FakeVendor() as vendor:
        with TestClient(create_gateway_app(), headers={"Authorization": "Bearer " + token}) as client:
            yield vendor, client


CHAT = "/gateway/v1/openai/chat/completions"
NATIVES = ["anthropic-messages", "gemini-generate-content"]


@pytest.mark.parametrize("protocol", NATIVES)
def test_native_json_tools_image_and_errors(protocol, gateway):
    from tests.test_anthropic_protocol_calls import REPLY
    vendor, client = gateway
    member("native", protocol, vendor.url)
    req = {"model": "shared", "messages": [{"role": "user", "content": [
        {"type": "text", "text": "see"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,YQ=="}}]}]}
    if protocol == "anthropic-messages":
        path = "/v1/messages"
        reply = {**REPLY, "stop_reason": "tool_use", "content": [{"type": "text", "text": "yes"}, *[
            {"type": "tool_use", "id": "tool-" + n, "name": n, "input": {}} for n in ("one", "two")]]}
    else:
        path = "/v1beta/models/shared:generateContent"
        reply = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "yes"}, *[
            {"functionCall": {"name": n, "args": {}}} for n in ("one", "two")]]}}]}
    vendor.on("POST", path, reply, (400, {"error": {"message": "native detail"}}),
              (503, {"code": "updating", "error": {"message": "temporary upstream failure"}}))
    result = client.post(CHAT, json=req)
    assert result.status_code == 200, result.text
    msg = result.json()["choices"][0]["message"]
    assert msg["content"] == "yes" and [t["function"]["name"] for t in msg["tool_calls"]] == ["one", "two"]
    assert b'YQ==' in vendor.received[0].body and b'image_url' not in vendor.received[0].body
    for status, detail in [(400, "native detail"), (503, "temporary upstream failure")]:
        failure = client.post(CHAT, json=req)
        assert failure.status_code == status and detail in failure.json()["error"]["message"]
        assert "code" not in failure.json()
    assert len(vendor.received) == 3
