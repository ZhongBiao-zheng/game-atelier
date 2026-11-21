"""第 7 批 7-A：网关密钥的可用范围改成「供应商 → 它的模型」。

原因（Windows 实机复现）：旧范围是两张独立名单 allowed_models 与 allowed_aliases，判定取交集。
设置页关掉「全部供应商」就写成 allowed_aliases=[]，只勾模型、不勾供应商时交集为空：
成员「连接网关」拿到 0 个模型，接入表单的保存按钮静默禁用，表现为「加不上这个供应商」。
新结构里模型挂在供应商下面，表达不出「选了模型但供应商没开」；判定只有 member_in_scope 一处。
"""
from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import (
    callers, gateway_access, gateway_audit, gateway_keys, gateway_quota, gateway_tasks, keys,
    model_routes,
)
from tests.local_client import LocalTestClient
from tests.test_gateway import _dispatch, _seed_keys, _submit
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app


@pytest.fixture(autouse=True)
def isolated_state(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    _seed_keys()  # 供应商 A、B（openai，gpt-image-2）与局域网 Hub
    yield
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()


def _admin():
    return LocalTestClient(base_url="http://127.0.0.1", app=build_app())


def _member(token):
    return TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})


def _member_of(alias, model_id="gpt-image-2"):
    return model_routes.RouteMember(alias=alias, provider="openai", base_url=None,
                                    model_id=model_id, name=model_id, protocol=None)


def _submit_task(owner, nonce):
    return gateway_tasks.submit(owner, idempotency_key=nonce, model="gpt-image-2", prompt="猫", n=1,
                                size=None, params={}, files={})


# ---------------------------------------------------------------- 复现的问题


def test_admin_picks_a_model_under_one_provider_and_the_member_can_see_and_use_it():
    """旧代码上红：设置页按「模型 + 供应商」设范围后，成员必须能看到并提交这个模型。"""
    record, token = gateway_keys.create_key("小王")
    response = _admin().patch(f"/api/gateway/keys/{record.id}",
                              json={"scope": [{"alias": "B", "models": ["gpt-image-2"]}]})
    assert response.status_code == 200
    assert response.json()["scope"] == [{"alias": "B", "models": ["gpt-image-2"]}]
    member = _member(token)
    assert "gpt-image-2" in [model["id"] for model in member.get("/gateway/v1/models").json()["models"]]
    assert _submit(member).status_code == 202


# ---------------------------------------------------------------- 唯一判定


@pytest.mark.parametrize(("scope", "member", "allowed"), [
    (None, _member_of("A"), True),
    ([], _member_of("A"), False),
    ([{"alias": "A"}], _member_of("A", "added-later"), True),  # 勾供应商 = 含它以后新增的模型
    ([{"alias": "A", "models": ["gpt-image-2"]}], _member_of("A"), True),
    ([{"alias": "A", "models": ["gpt-image-2"]}], _member_of("A", "other"), False),
    ([{"alias": "A", "models": ["gpt-image-2"]}], _member_of("B"), False),
    ([{"alias": "A", "models": []}], _member_of("A"), False),
])
def test_member_in_scope(scope, member, allowed):
    record, _ = gateway_keys.create_key("小王", scope=scope)
    assert gateway_access.member_in_scope(record, member) is allowed


def test_execution_and_fallback_only_use_members_in_scope(monkeypatch):
    owner, _ = gateway_keys.create_key("小王", scope=[{"alias": "B", "models": ["gpt-image-2"]}])
    model_routes.cool_down("image", "B", "auth")  # B 冷却时也不退到范围外的 A
    assert gateway_tasks._pick_member("gpt-image-2", [], owner)[0].alias == "B"
    model_routes._cooldowns.clear()
    calls = []
    monkeypatch.setattr(callers, "dispatch", _dispatch(calls))
    assert gateway_tasks.run_task(_submit_task(owner, "one")).member_alias == "B"
    task = _submit_task(owner, "two")
    gateway_keys.update_key(owner.id, scope=[{"alias": "A", "models": ["other"]}])  # 排队时收窄
    assert gateway_tasks.run_task(task).status == "failed"
    assert [call["alias"] for call in calls] == ["B"]


def test_route_outside_scope_is_hidden_and_refused():
    _record, token = gateway_keys.create_key("小王", scope=[{"alias": "A", "models": ["other"]}])
    member = _member(token)
    assert member.get("/gateway/v1/models").json()["models"] == []
    response = _submit(member)
    assert response.status_code == 403 and "gpt-image-2" in response.json()["detail"]


@pytest.mark.parametrize("scope", [[], [{"alias": "A", "models": []}]])
def test_saving_an_empty_scope_is_rejected_but_an_existing_one_still_reads(scope):
    record, _ = gateway_keys.create_key("小王", scope=[])  # 旧数据转换来的空范围
    admin = _admin()
    assert admin.get("/api/gateway").json()["keys"][0]["scope"] == []
    response = admin.patch(f"/api/gateway/keys/{record.id}", json={"scope": scope})
    assert response.status_code == 422 and "至少选一个模型" in response.text
    assert admin.post("/api/gateway/keys", json={"name": "小李", "scope": scope}).status_code == 422


def test_same_provider_twice_is_rejected():
    record, _ = gateway_keys.create_key("小王")
    response = _admin().patch(f"/api/gateway/keys/{record.id}",
                              json={"scope": [{"alias": "A"}, {"alias": "A", "models": ["x"]}]})
    assert response.status_code == 422


# ---------------------------------------------------------------- 设置页选项与删除供应商


def test_options_group_models_under_providers_and_list_disabled_ones():
    keys.patch_key("B", {"enabled": False})
    options = _admin().get("/api/gateway/options").json()
    by_alias = {item["alias"]: item for item in options["providers"]}
    assert "Hub" not in by_alias  # 局域网 Atelier 不经网关转发
    assert by_alias["A"]["enabled"] is True
    assert [model["id"] for model in by_alias["A"]["models"]] == ["gpt-image-2"]
    assert by_alias["A"]["models"][0]["route_id"] == "gpt-image-2"
    assert by_alias["B"]["enabled"] is False and by_alias["B"]["models"][0]["id"] == "gpt-image-2"


def test_deleting_a_provider_drops_it_from_every_scope():
    narrowed, _ = gateway_keys.create_key("小王", scope=[{"alias": "A"}, {"alias": "B"}])
    everything, _ = gateway_keys.create_key("小李")
    assert _admin().delete("/api/keys/A").status_code == 204
    config = {record.id: record for record in gateway_keys.read_config().keys}
    assert [entry.alias for entry in config[narrowed.id].scope] == ["B"]
    assert config[everything.id].scope is None
    rows = [row for row in gateway_audit.read() if row["action"] == "member.scope_drop_provider"]
    assert [row["target_id"] for row in rows] == [narrowed.id]
    # 之后再建同名供应商不会自动进这把密钥的范围
    keys.add_key(keys.KeySpec(alias="A", provider="openai", access_key="test-only", created_at="test",
                              models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")]))
    assert not gateway_access.member_in_scope(gateway_keys.read_config().keys[0], _member_of("A"))


# ---------------------------------------------------------------- 旧范围转换（PLAN-7「旧范围转换表」）


def _add_video_provider():
    keys.add_key(keys.KeySpec(alias="V", provider="custom", access_key="test-only", created_at="test",
                              base_url="https://v.example", models=[
                                  keys.ModelSpec(id="sd-a", name="sd-a", modality="video", protocol="seedance"),
                                  keys.ModelSpec(id="sd-b", name="sd-b", modality="video", protocol="seedance"),
                                  keys.ModelSpec(id="other", name="other", modality="video", protocol="kling")]))


def _write_legacy(**fields):
    gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"][0].pop("scope", None)
    raw["keys"][0].update(fields)
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def _old_visible(models, aliases, member):
    """第 7 批前的判定（gateway_access.model_allowed + member_allowed），用来核对等价。"""
    route = model_routes.route_id(*next((m, k) for k in keys.read_keys_db().keys if k.alias == member.alias
                                        for m in k.models if m.id == member.model_id))
    return (models is None or any(gateway_keys._legacy_pattern_matches(p, route) for p in models)) and (
        aliases is None or member.alias in aliases)


ALL_MEMBERS = [("A", "gpt-image-2"), ("B", "gpt-image-2"), ("V", "sd-a"), ("V", "sd-b"), ("V", "other")]


@pytest.mark.parametrize(("models", "aliases", "expected", "change"), [
    (None, None, None, "等价"),
    (None, ["B", "V"], [{"alias": "B", "models": None}, {"alias": "V", "models": None}], "等价"),
    (None, [], [], "等价：仍不可用"),
    (["gpt-image-2"], ["B"], [{"alias": "B", "models": ["gpt-image-2"]}], "等价"),
    (["gpt-image-2"], None, [{"alias": "A", "models": ["gpt-image-2"]}, {"alias": "B", "models": ["gpt-image-2"]}],
     "当时等价，以后新增的供应商不含（变严）"),
    (["gpt-image-2"], ["V"], [], "等价：本来就不可见"),
    ([], None, [], "等价：仍不可用"),
])
def test_legacy_scope_conversion_table(models, aliases, expected, change):
    _add_video_provider()
    _write_legacy(allowed_models=models, allowed_aliases=aliases)
    record = gateway_keys.read_config().keys[0]
    assert ([entry.model_dump() for entry in record.scope] if record.scope is not None else None) == expected
    for alias, model_id in ALL_MEMBERS:  # 转换当时，新判定与旧判定逐个成员一致
        member = _member_of(alias, model_id)
        assert gateway_access.member_in_scope(record, member) is _old_visible(models, aliases, member), change


def test_models_with_every_provider_off_become_usable_through_current_providers(caplog):
    """飙哥这次的状态：只选了模型、供应商全关。2026-11-20 定「直接可用」（变宽）。"""
    _add_video_provider()
    _write_legacy(allowed_models=["gpt-image-2"], allowed_aliases=[])
    with caplog.at_level(logging.WARNING, logger="character_workflow.lib.gateway_keys"):
        record = gateway_keys.read_config().keys[0]
    assert [entry.model_dump() for entry in record.scope] == [
        {"alias": "A", "models": ["gpt-image-2"]}, {"alias": "B", "models": ["gpt-image-2"]}]  # 不是「全部」
    assert "widened" in caplog.text and "小王" in caplog.text and "atg_" not in caplog.text


def test_prefix_expands_to_the_models_it_matched_at_conversion_time(caplog):
    _add_video_provider()
    _write_legacy(allowed_models=["seedance:*"], allowed_aliases=None)
    with caplog.at_level(logging.WARNING, logger="character_workflow.lib.gateway_keys"):
        record = gateway_keys.read_config().keys[0]
    # 恰好是 V 的两个 seedance 模型，没升级成「V 的全部」：V 的 kling 模型不在范围里，以后新增的也不在。
    assert [entry.model_dump() for entry in record.scope] == [{"alias": "V", "models": ["sd-a", "sd-b"]}]
    assert "prefix" in caplog.text


def test_conversion_is_written_back_once():
    path = _write_legacy(allowed_models=["gpt-image-2"], allowed_aliases=["A"])
    gateway_keys.read_config()
    saved = json.loads(path.read_text(encoding="utf-8"))["keys"][0]
    # 有范围的密钥另写 allowed_models=[]：回滚到旧版时它一个模型都用不了（只严不宽，R1）。
    assert saved["allowed_models"] == [] and "allowed_aliases" not in saved
    assert saved["scope"] == [{"alias": "A", "models": ["gpt-image-2"]}]
    before = path.read_bytes()
    gateway_keys.read_config()
    assert path.read_bytes() == before


def test_unreadable_providers_keep_old_keys_closed_and_untouched(monkeypatch):
    path = _write_legacy(allowed_models=["gpt-image-2"], allowed_aliases=None)
    before = path.read_bytes()

    def broken():
        raise ValueError("keys.json 坏了")
    monkeypatch.setattr(gateway_keys, "_legacy_members", broken)
    assert gateway_keys.read_config().keys[0].scope == []
    assert path.read_bytes() == before  # 不写回，修好后下次读再转
