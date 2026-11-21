"""第 7 批 R1：回滚到第 7 批前的版本（更新器回滚或手动装回旧包）时，受限密钥只能更严，不能更宽。

旧版不认识 scope / quota，读 gateway.json 时按 allowed_models / allowed_aliases / limits 判定。新版写盘时给有范围或
额度的密钥另写 allowed_models=[]，旧版读到 = 一个模型都用不了；无限制的密钥照常可用。
下面的旧版模型与判定从 5e029d16 原样抄来，不要改。
"""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from character_workflow.lib import gateway_keys
from character_workflow.lib.private_json import read_private_json, write_private_json

DEFAULT_PORT = 5180

# ---------------------------------------------------------------- 5e029d16 原样

LimitPeriod = Literal["day", "week", "month"]


class GatewayLimit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: LimitPeriod
    cap_cny: float = Field(gt=0, le=1_000_000)


class GatewayPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limits: list[GatewayLimit] = Field(default_factory=list, max_length=3)
    allowed_models: list[str] | None = None
    allowed_aliases: list[str] | None = None

    @field_validator("limits")
    @classmethod
    def unique_periods(cls, limits):
        if len({limit.period for limit in limits}) != len(limits):
            raise ValueError("同一限额窗口只能设置一次")
        return limits


class GatewayKeyRecord(GatewayPolicy):
    # 本机旧配置中的 daily_image_limit 读入即丢弃，不迁移、不保留旧协议。
    model_config = ConfigDict(extra="ignore")
    id: str
    name: str = Field(min_length=1, max_length=40)
    role: Literal["member", "admin"] = "member"
    token_sha256: str
    token: str = Field(default="", repr=False)
    created_at: str
    revoked_at: str | None = None


class GatewayConfig(BaseModel):
    enabled: bool = False
    port: int = Field(default=DEFAULT_PORT, ge=1024, le=65535)
    name: str = Field(default="", max_length=40)
    keys: list[GatewayKeyRecord] = Field(default_factory=list)


def member_allowed(key: GatewayKeyRecord, alias: str) -> bool:
    return key.allowed_aliases is None or alias in key.allowed_aliases


def model_allowed(key: GatewayKeyRecord, route_id: str) -> bool:
    return key.allowed_models is None or any(
        route_id == pattern or (pattern.endswith("*") and route_id.startswith(pattern[:-1]))
        for pattern in key.allowed_models
    )

# ---------------------------------------------------------------- 用例

ROUTES = ["gpt-image-2", "seedance:sd-a", "anything"]


def _old_view():
    config = GatewayConfig.model_validate(read_private_json(gateway_keys.gateway_file(), 2 * 1024 * 1024))
    return {key.name: key for key in config.keys}


def _old_usable(key: GatewayKeyRecord) -> bool:
    return any(model_allowed(key, route) and member_allowed(key, "A") for route in ROUTES)


def _write_keys():
    gateway_keys.create_key("范围", scope=[{"alias": "A", "models": ["gpt-image-2"]}])
    gateway_keys.create_key("额度", {"cap_cny": 5, "period": "day"})
    gateway_keys.create_key("两者", {"cap_cny": 5, "period": "none"}, scope=[{"alias": "A"}])
    gateway_keys.create_key("不限")


def test_old_version_reading_the_new_file_locks_every_restricted_key(isolated_data_root):
    _write_keys()
    old = _old_view()
    assert not _old_usable(old["范围"])
    assert not _old_usable(old["额度"])  # 旧版看不到额度，不能因此变成不限额
    assert not _old_usable(old["两者"])
    assert _old_usable(old["不限"]) and old["不限"].limits == []


def test_old_version_writing_back_reads_as_an_empty_scope_not_everything(isolated_data_root):
    _write_keys()
    old = GatewayConfig.model_validate(read_private_json(gateway_keys.gateway_file(), 2 * 1024 * 1024))
    write_private_json(gateway_keys.gateway_file(), old.model_dump(mode="json"))  # 旧版写回：scope / quota 丢了
    new = {key.name: key for key in gateway_keys.read_config().keys}
    for name in ("范围", "额度", "两者"):
        assert new[name].scope == [], name
    assert new["不限"].scope is None and new["不限"].quota is None


def test_new_version_ignores_the_lockout_marker_next_to_scope(isolated_data_root):
    _write_keys()
    path = gateway_keys.gateway_file()
    before = path.read_bytes()
    new = {key.name: key for key in gateway_keys.read_config().keys}
    assert [entry.model_dump() for entry in new["范围"].scope] == [{"alias": "A", "models": ["gpt-image-2"]}]
    assert new["额度"].scope is None and new["额度"].quota.period == "day"
    assert path.read_bytes() == before  # 有 scope 键就不再转换，也不重写
    saved = {item["name"]: item for item in json.loads(before)["keys"]}
    assert saved["范围"]["allowed_models"] == [] and "allowed_models" not in saved["不限"]
