"""第 5 批 5-6B：Canvas MCP 的自定义接口接入说明与干跑校验（ADR-0036）。

有效的本机 Agent 会话即可调用（不加能力开关、不挂项目）。守住三条：校验后 `.config/http-protocols/` 与
`keys.json` 逐字节不变；出站请求全部打桩为失败时校验照常返回；本机管理接口 `/api/http-protocols*` 对 Agent 会话仍拒绝。
"""
from __future__ import annotations

import json
import socket
import time
from importlib.resources import files
from pathlib import Path

import pytest
import requests
from mcp.client import Client

from character_workflow.lib import http_protocols, keys
from character_workflow.lib.http_protocol_schema import MAX_DOCUMENT_BYTES
from character_workflow.mcp import client as adapter
from character_workflow.mcp.server import create_server
from character_workflow.mcp.tool_catalog import TOOL_DEFINITIONS
from tests.test_ps_bridge_agent import _agent_headers, _client

MANUAL = files("character_workflow").joinpath("data/http_protocol_manual.md").read_text(encoding="utf-8")
EXAMPLES = {item["id"]: item["document"] for item in json.loads(
    Path("web/src/pages/settings/customInterfaceExamples.json").read_text(encoding="utf-8"))}
IMAGE = EXAMPLES["openai-sync-image"]


# ---------------------------------------------------------------- MCP 工具面


class FakeCanvas:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def close(self) -> None:
        pass

    def available_plugin_tools(self) -> set[str]:
        return set()

    def call(self, operation: str, payload) -> dict:
        self.calls.append((operation, payload.model_dump(mode="json")))
        return {"markdown": "说明"} if operation == "atelier-protocol-manual" else {"valid": True}


def test_both_tools_are_read_only_and_free():
    tools = {tool.name: tool for tool in TOOL_DEFINITIONS}
    for name in ("atelier_protocol_manual", "atelier_protocol_validate"):
        assert tools[name].read_only and not tools[name].billable
    assert adapter.OPERATIONS["atelier-protocol-manual"] == "/api/canvas-agent/protocol-manual"
    assert adapter.OPERATIONS["atelier-protocol-validate"] == "/api/canvas-agent/protocol-validate"


async def test_tools_are_listed_without_plugins_and_take_strict_arguments():
    fake = FakeCanvas()
    async with Client(create_server(fake)) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
        assert {"atelier_protocol_manual", "atelier_protocol_validate"} <= names
        ok = await client.call_tool("atelier_protocol_validate", {"payload": {"document": IMAGE}})
        extra = await client.call_tool("atelier_protocol_validate",
                                       {"payload": {"document": IMAGE, "save": True}})
        manual = await client.call_tool("atelier_protocol_manual", {"payload": {}})
    assert not ok.is_error and not manual.is_error and extra.is_error
    assert fake.calls == [("atelier-protocol-validate", {"document": IMAGE}),
                          ("atelier-protocol-manual", {})]


# ---------------------------------------------------------------- 服务端


@pytest.fixture
def agent(tmp_path):
    client, headers = _agent_headers(_client(tmp_path))
    return client, headers


def _post(agent, path, body):
    client, headers = agent
    return client.post(f"/api/canvas-agent/{path}", json=body, headers=headers)


def test_without_an_agent_session_both_tools_are_refused(tmp_path):
    browser = _client(tmp_path)  # 本机页面会话：能到 /api/canvas-agent/，在接口里按「不是 Agent」拒掉
    anonymous = type(browser).__mro__[1](browser.app, base_url="http://127.0.0.1")
    for path, body in (("protocol-manual", {}), ("protocol-validate", {"document": IMAGE})):
        assert anonymous.post(f"/api/canvas-agent/{path}", json=body).status_code == 401
        refused = browser.post(f"/api/canvas-agent/{path}", json=body)
        assert refused.status_code == 403 and refused.json()["error"]["code"] == "CAPABILITY_DENIED"


def test_manual_is_the_same_file_the_copy_button_uses(agent):
    response = _post(agent, "protocol-manual", {})
    assert response.status_code == 200 and response.json() == {"markdown": MANUAL}


def test_validate_reports_issues_then_a_preview_without_the_auth_header(agent):
    broken = _post(agent, "protocol-validate", {"document": {**IMAGE, "submit": {
        **IMAGE["submit"], "path": "https://api.example.com/v1/images"}}})
    assert broken.status_code == 200 and broken.json()["valid"] is False
    assert any(issue["path"].startswith("submit") for issue in broken.json()["issues"])

    result = _post(agent, "protocol-validate", {"document": IMAGE}).json()
    assert result["valid"] is True and result["declared"]["kind"] == "image"
    submit = result["preview"]["submit"]
    assert submit["url"].startswith("https://服务地址/")
    assert submit["hidden_fields"] == ["headers.Authorization"]
    assert all(name.lower() != "authorization" for name in submit["headers"])
    assert adapter._safe_result(result)  # MCP 适配器会放行（含 authorization 字段的结果会被它拒掉）


@pytest.mark.parametrize(("auth", "body_extra", "hidden", "in_url"), [
    # 请求体里有同名字段（如厂商要求把 key 放进 JSON 体，模板里先写占位）：拿掉，报路径。
    ({"type": "none"}, {"api_key": "fill-in", "options": {"Access_Key": "x"}},
     ["body.api_key", "body.options.Access_Key"], None),
    # 查询串鉴权：在 url 字符串里，不是字段名，原样返回。
    ({"type": "query", "name": "api_key"}, {}, None, "api_key=%2A%2A%2A"),
    # 请求头鉴权：头名与 PRIVATE_KEYS 同名（不分大小写）时拿掉，报路径。
    ({"type": "header", "name": "Api_Key"}, {}, ["headers.Api_Key"], None),
    ({"type": "header", "name": "X-Api-Key"}, {}, None, None),
])
def test_fields_the_mcp_adapter_refuses_are_hidden_not_fatal(agent, auth, body_extra, hidden, in_url):
    document = {**IMAGE, "auth": auth,
                "submit": {**IMAGE["submit"], "body": {**IMAGE["submit"]["body"], **body_extra}}}
    result = _post(agent, "protocol-validate", {"document": document}).json()
    assert result["valid"] is True
    submit = result["preview"]["submit"]
    assert submit.get("hidden_fields") == hidden
    assert submit["body"]["prompt"] == "示例提示词"  # 其余预览照常
    if in_url:
        assert in_url in submit["url"]
    assert adapter._safe_result(result)


def _config_snapshot(root: Path) -> dict[str, bytes]:
    config = root / ".config"
    return {str(path.relative_to(config)): path.read_bytes()
            for path in sorted(config.rglob("*")) if path.is_file()}


def test_validate_never_writes_and_never_goes_out(agent, monkeypatch, isolated_data_root):
    keys.write_keys_db(keys.KeysDB())
    http_protocols.save_protocol(IMAGE)
    before = _config_snapshot(isolated_data_root)
    assert "keys.json" in before and any(name.startswith("http-protocols") for name in before)
    attempts: list[str] = []

    def blocked(*args, **_kwargs):
        attempts.append(repr(args[:2]))
        raise OSError("outbound blocked in this test")

    monkeypatch.setattr(requests.Session, "request", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    for document in (IMAGE, EXAMPLES["async-video-task"], {"version": 1}):
        assert _post(agent, "protocol-validate", {"document": document}).status_code == 200
    assert _post(agent, "protocol-manual", {}).status_code == 200
    assert attempts == []
    assert _config_snapshot(isolated_data_root) == before


def test_url_encoded_references_reveal_only_whether_object_storage_is_configured(agent):
    document = {**IMAGE, "inputs": {"images": {"max": 4, "encode": "url"}}}
    result = _post(agent, "protocol-validate", {"document": document}).json()
    assert result["valid"] is False
    assert [issue["path"] for issue in result["issues"]] == ["inputs.images.encode"]


@pytest.mark.parametrize(("method", "path"), [
    ("GET", "/api/http-protocols"), ("POST", "/api/http-protocols"),
    ("POST", "/api/http-protocols/validate"), ("GET", "/api/http-protocols/assist/models"),
    ("POST", "/api/http-protocols/assist"), ("GET", "/api/http-protocols/hp-aaaaaaaaaaaa"),
    ("PUT", "/api/http-protocols/hp-aaaaaaaaaaaa"), ("DELETE", "/api/http-protocols/hp-aaaaaaaaaaaa"),
    ("GET", "/api/keys"),
])
def test_local_management_routes_stay_closed_to_agents(agent, method, path):
    client, headers = agent
    response = client.request(method, path, json={"document": IMAGE}, headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "CAPABILITY_DENIED"


def _padded(size: int) -> dict:
    """在请求体里加一个常量字段撑到指定大小：模板仍合法，预览会原样带出这段（量的是完整校验 + 预览）。"""
    base = len(json.dumps(IMAGE, ensure_ascii=False).encode())
    return {**IMAGE, "submit": {**IMAGE["submit"], "body": {
        **IMAGE["submit"]["body"], "notes": "x" * (size - base - 20)}}}


def test_documents_over_200_kb_are_refused_with_a_clear_error(agent):
    big = _padded(210 * 1024)
    assert len(json.dumps(big, ensure_ascii=False).encode()) > 200 * 1024
    response = _post(agent, "protocol-validate", {"document": big})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "CONTENT_TOO_LARGE"
    assert "200 KB" in response.json()["error"]["message"]


def test_between_the_template_cap_and_the_request_cap_the_template_rule_answers(agent):
    """模板本身上限 64 KB（http_protocol_schema.MAX_DOCUMENT_BYTES）；200 KB 是这个接口的请求上限。"""
    response = _post(agent, "protocol-validate", {"document": _padded(195 * 1024)})
    assert response.status_code == 200 and response.json()["valid"] is False
    assert response.json()["issues"] == [{"path": "(根)", "message": "模板超过 64 KB"}]


def test_the_largest_valid_template_validates_in_bounded_time(agent):
    document = _padded(MAX_DOCUMENT_BYTES - 1024)
    started = time.perf_counter()
    response = _post(agent, "protocol-validate", {"document": document})
    elapsed = time.perf_counter() - started
    assert response.status_code == 200 and response.json()["valid"] is True
    assert elapsed < 5, elapsed
