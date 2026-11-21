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
