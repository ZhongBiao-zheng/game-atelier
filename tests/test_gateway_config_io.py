"""第 7 批 R3–R6：gateway.json 读写的健壮性。

- R3 读入时写回转换结果失败（Windows 文件被占用、目录只读）不能让服务起不来。
- R4 旧 limits：旧版能读的值都转（数字字符串算），旧版也读不懂的照旧报配置损坏，不静默变成不限额。
- R5 持久化模型读盘时不查长度、条数与唯一性；旧字段类型不对报配置损坏，不抛裸 TypeError。
- R6 读写同一个上限，写入超限时拒绝保存并给明确报错。
"""
from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, keys
from tests.local_client import LocalTestClient
from viewer_server.gateway_app import create_gateway_app
from viewer_server.server_app import build_app


def _write_raw(**fields):
    """一把旧格式（第 7 批前）的密钥，字段原样写盘。"""
    record, token = gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    for field in ("scope", "quota", "allowed_models"):
        raw["keys"][0].pop(field, None)
    raw["keys"][0].update(fields)
    path.write_text(json.dumps(raw), encoding="utf-8")
    return record, token, path


# ---------------------------------------------------------------- R3


def test_failed_write_back_keeps_serving_the_converted_config(isolated_data_root, monkeypatch, caplog):
    _record, token, path = _write_raw(limits=[{"period": "day", "cap_cny": 5}])
    before = path.read_bytes()

    def locked(*_args, **_kwargs):
        raise PermissionError("file is in use")
    with monkeypatch.context() as patch:
        patch.setattr(gateway_keys, "write_private_json", locked)
        with caplog.at_level(logging.WARNING, logger="character_workflow.lib.gateway_keys"):
            config = gateway_keys.read_config()
        assert config.keys[0].quota.period == "day"
        assert "写回失败" in caplog.text and path.read_bytes() == before
        response = TestClient(create_gateway_app()).get(
            "/gateway/v1/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200 and response.json()["quota"]["cap_cny"] == 5
    gateway_keys.read_config()  # 下次读时再写
    assert "quota" in json.loads(path.read_text(encoding="utf-8"))["keys"][0]


# ---------------------------------------------------------------- R4


def test_numeric_string_amount_the_old_version_accepted_still_converts(isolated_data_root):
    _write_raw(limits=[{"period": "week", "cap_cny": "12.5"}])
    quota = gateway_keys.read_config().keys[0].quota
    assert (quota.period, quota.cap_cny) == ("week", 12.5)


@pytest.mark.parametrize("limits", [
    "day:5",                                        # 不是列表
    [{"period": "hour", "cap_cny": 5}],             # 不认识的周期
    [{"period": "day", "cap_cny": "five"}],         # 金额读不出
    [{"period": "day", "cap_cny": 0}],              # 旧版也不收
    [{"period": "day", "cap_cny": 1}, {"period": "day", "cap_cny": 2}],  # 旧版的同周期两条
])
def test_limits_the_old_version_could_not_read_stay_corrupt_instead_of_unlimited(isolated_data_root, limits):
    _record, _token, path = _write_raw(limits=limits)
    before = path.read_bytes()
    with pytest.raises(gateway_keys.GatewayConfigCorruptError):
        gateway_keys.read_config()
    assert path.read_bytes() == before


def test_several_old_limits_warning_names_the_key(isolated_data_root, caplog):
    _write_raw(limits=[{"period": "day", "cap_cny": 1}, {"period": "month", "cap_cny": 9}])
    with caplog.at_level(logging.WARNING, logger="character_workflow.lib.gateway_keys"):
        assert gateway_keys.read_config().keys[0].quota.period == "month"
    assert "「小王」" in caplog.text and "旧额度" in caplog.text


# ---------------------------------------------------------------- R5


def test_long_aliases_and_model_ids_from_keys_json_still_convert(isolated_data_root):
    alias, model_id = "供" * 150, "m" * 300  # keys.json 里这两个都没有长度上限
    keys.add_key(keys.KeySpec(alias=alias, provider="openai", access_key="test-only", created_at="test",
                              models=[keys.ModelSpec(id=model_id, name="x", modality="image")]))
    _write_raw(allowed_models=[model_id], allowed_aliases=[alias])
    record = gateway_keys.read_config().keys[0]
    assert [entry.model_dump() for entry in record.scope] == [{"alias": alias, "models": [model_id]}]


@pytest.mark.parametrize("fields", [
    {"allowed_models": 5}, {"allowed_aliases": "A"}, {"allowed_models": [1, 2]}, {"allowed_aliases": [None]},
])
def test_unreadable_old_scope_fields_are_a_corrupt_config(isolated_data_root, fields):
    with pytest.raises(gateway_keys.GatewayConfigCorruptError):
        _write_raw(**fields)
        gateway_keys.read_config()


def test_stored_scope_is_read_without_the_write_limits(isolated_data_root):
    gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"][0]["scope"] = [{"alias": "A" * 200, "models": ["m"] * 600},
                               {"alias": "B", "models": None}, {"alias": "B", "models": None}]
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert len(gateway_keys.read_config().keys[0].scope) == 3  # 读盘不报损坏


def test_write_boundary_still_enforces_the_limits(isolated_data_root):
    record, _ = gateway_keys.create_key("小王")
    admin = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    for scope in ([{"alias": "A" * 121}], [{"alias": "A", "models": ["m" * 201]}],
                  [{"alias": "A", "models": [f"m{i}" for i in range(501)]}], [{"alias": "A"}, {"alias": "A"}]):
        assert admin.patch(f"/api/gateway/keys/{record.id}", json={"scope": scope}).status_code == 422


# ---------------------------------------------------------------- R6


def _big_scope(providers=5, models=100):
    return [{"alias": f"provider-{p}", "models": [f"vendor-{p}/some-image-model-name-{m:04d}" for m in range(models)]}
            for p in range(providers)]


def test_thirty_keys_with_five_providers_of_a_hundred_models_round_trip(isolated_data_root):
    for index in range(30):
        gateway_keys.create_key(f"成员{index}", {"cap_cny": 5, "period": "week"}, scope=_big_scope())
    config = gateway_keys.read_config()
    assert len(config.keys) == 30 and len(config.keys[29].scope[4].models) == 100
    assert gateway_keys.gateway_file().stat().st_size < gateway_keys._MAX_FILE_BYTES // 2  # 留足余量


def test_a_write_over_the_limit_is_refused_and_the_file_is_untouched(isolated_data_root, monkeypatch):
    record, _ = gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    before = path.read_bytes()
    monkeypatch.setattr(gateway_keys, "_MAX_FILE_BYTES", len(before) + 200)
    admin = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    response = admin.patch(f"/api/gateway/keys/{record.id}", json={"scope": _big_scope(1, 50)})
    assert response.status_code == 413 and "上限" in response.json()["detail"]
    assert path.read_bytes() == before
    assert gateway_keys.read_config().keys[0].scope is None


# ---------------------------------------------------------------- 复核收尾三项


@pytest.mark.parametrize("entry", [{"alias": "A", "model": ["x"]}, {"alias": "A"}])
def test_scope_entry_with_an_unknown_or_missing_models_key_is_corrupt(isolated_data_root, entry):
    """手改把 models 写错成 model，或漏掉 models：读不懂就报损坏，不能读成「该供应商全部」。"""
    gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"][0]["scope"] = [entry]
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(gateway_keys.GatewayConfigCorruptError):
        gateway_keys.read_config()


@pytest.mark.parametrize("value", [5, True, "abc"])
def test_keys_that_is_not_a_list_is_a_corrupt_config(isolated_data_root, value):
    gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"] = value
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(gateway_keys.GatewayConfigCorruptError):
        gateway_keys.read_config()


def test_hash_only_key_is_not_reissued_until_the_file_can_be_written(isolated_data_root, monkeypatch):
    record, _token = gateway_keys.create_key("小王")
    path = gateway_keys.gateway_file()
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["keys"][0]["token"] = ""  # 只存哈希的旧密钥
    path.write_text(json.dumps(raw), encoding="utf-8")

    def locked(*_args, **_kwargs):
        raise PermissionError("file is in use")
    with monkeypatch.context() as patch:
        patch.setattr(gateway_keys, "write_private_json", locked)
        for _ in range(2):  # 每次读都不发明文，哈希不变
            key = gateway_keys.read_config().keys[0]
            assert key.token == "" and key.token_sha256 == record.token_sha256
    issued = gateway_keys.read_config().keys[0].token
    assert issued and gateway_keys.read_config().keys[0].token == issued  # 能写回时发一次，之后不变
    assert json.loads(path.read_text(encoding="utf-8"))["keys"][0]["token"] == issued

