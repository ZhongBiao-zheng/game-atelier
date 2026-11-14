"""自定义接口模板：结构 / 语义校验、渲染、取值（夹具与 vitest 共用）。"""
import json
from pathlib import Path

import pytest

from character_workflow.lib.http_protocol_render import (
    MISSING, derive_values, render, render_path, resolve_path, strings_at,
)
from character_workflow.lib.http_protocol_schema import (
    ProtocolInvalidError, declared_capabilities, parse_protocol,
)

CASES = json.loads((Path(__file__).parent / "fixtures/http_protocol_cases.json").read_text())


@pytest.mark.parametrize("case", CASES["valid"], ids=lambda c: c["name"])
def test_valid_documents_and_declared_capabilities(case):
    protocol = parse_protocol(case["document"])
    assert declared_capabilities(protocol) == case["declared"]


def test_base_document_is_valid():
    parse_protocol(CASES["base"])


@pytest.mark.parametrize("case", CASES["invalid"], ids=lambda c: c["name"])
def test_invalid_documents_point_at_the_field(case):
    with pytest.raises(ProtocolInvalidError) as error:
        parse_protocol({**CASES["base"], **case["patch"]})
    assert case["path"] in [issue.path for issue in error.value.issues]


@pytest.mark.parametrize("document", [[], "x", None, 1])
def test_document_must_be_an_object(document):
    with pytest.raises(ProtocolInvalidError):
        parse_protocol(document)


def test_size_and_depth_limits():
    deep: dict = {}
    cursor = deep
    for _ in range(20):
        cursor["a"] = {}
        cursor = cursor["a"]
    with pytest.raises(ProtocolInvalidError, match="嵌套"):
        parse_protocol({**CASES["base"], "submit": {"path": "/v1/x", "body": deep}})
    with pytest.raises(ProtocolInvalidError, match="64 KB"):
        parse_protocol({**CASES["base"], "catalog": "y" * 70_000})
    with pytest.raises(ProtocolInvalidError, match="数组"):
        parse_protocol({**CASES["base"],
                        "submit": {"path": "/v1/x", "body": {"a": list(range(65))}}})


def test_render_keeps_types_drops_missing_and_unescapes():
    template = {"n": "$n", "images": "$images", "opt": "$ratio", "text": "画 ${prompt}!",
                "maybe": "a ${ratio}", "price": "$$5", "list": ["$prompt", "$ratio", 3],
                "nested": {"x": "$model"}}
    context = {"n": 2, "images": ["a", "b"], "prompt": "猫", "model": "m1", "ratio": None}
    assert render(template, context) == {
        "n": 2, "images": ["a", "b"], "text": "画 猫!", "price": "$5", "list": ["猫", 3],
        "nested": {"x": "m1"},
    }
    assert render("$ratio", {}) is MISSING


def test_render_path_encodes_values():
    assert render_path("/v1/tasks/${taskId}", {"taskId": "a/b?c#d"}) == "/v1/tasks/a%2Fb%3Fc%23d"
    with pytest.raises(ValueError):
        render_path("/v1/${model}", {})


def test_derive_single_and_pair():
    protocol = parse_protocol(CASES["valid"][2]["document"])
    assert derive_values(protocol.derive, {"ratio": "1:1", "resolution": "2K"}) == {
        "size": "2048x2048"}
    assert derive_values(protocol.derive, {"ratio": "1:1"}) == {}


def test_resolve_path():
    data = {"data": [{"url": "a"}, {"url": "b"}, {"b64": "c"}], "task": {"status": "ok"},
            "output": ["x", "y"]}
    assert resolve_path(data, "data.*.url") == ["a", "b"]
    assert resolve_path(data, "output.1") == ["y"]
    assert resolve_path(data, "output.9") == []
    assert resolve_path(data, "task.status") == ["ok"]
    assert resolve_path(data, "missing.path") == []
    assert strings_at(data, ["data.*.url", "data.0.url", "output.*"]) == ["a", "b", "x", "y"]
