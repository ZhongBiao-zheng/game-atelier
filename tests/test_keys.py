import pytest

from character_workflow.lib import data_root, keys


def _seed(payload: dict) -> None:
    keys.write_keys_db(keys.KeysDB.model_validate(payload))


def test_read_empty_when_file_missing(isolated_data_root):
    db = keys.read_keys_db()
    assert db.version == 1
    assert db.default_alias is None
    assert db.keys == []


def test_write_and_read_roundtrip(isolated_data_root):
    payload = {
        "version": 1,
        "default_alias": "lovart-primary",
        "keys": [{
            "alias": "lovart-primary",
            "provider": "seedream",
            "access_key": "ak_test",
            "secret_key": "sk_test",
            "capabilities": ["portrait", "promo", "turnaround"],
            "models": ["gpt_image_2"],
            "notes": "test",
            "created_at": "2026-05-22T14:00:00+08:00",
        }],
    }
    _seed(payload)
    db = keys.read_keys_db()
    assert db.default_alias == "lovart-primary"
    assert db.keys[0].alias == "lovart-primary"
    assert db.keys[0].access_key == "ak_test"


def test_key_spec_persists_provider_metadata(isolated_data_root):
    spec = keys.KeySpec(
        alias="seedream-main",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="ark-secret",
        secret_key=None,
        capabilities=["portrait"],
        models=[{"name": "图片 5.0", "id": "doubao-seedream-5-0-260128"}],
        homepage_url="https://www.volcengine.com",
        docs_url="https://www.volcengine.com/docs",
        api_key_url="https://console.volcengine.com/ark",
        modalities=["image"],
        notes="legacy note",
        created_at="2026-05-26T18:30:00+08:00",
    )

    keys.add_key(spec)
    row = keys.find_by_alias("seedream-main")

    assert row is not None
    assert row.homepage_url == "https://www.volcengine.com"
    assert row.docs_url == "https://www.volcengine.com/docs"
    assert row.api_key_url == "https://console.volcengine.com/ark"
    assert row.modalities == ["image"]
    assert row.notes == "legacy note"


def test_custom_key_persists_per_model_modality(isolated_data_root):
    spec = keys.KeySpec(
        alias="zz-general",
        provider="custom",
        base_url="https://api.aggregator.test",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[
            {"name": "GPT Image 2", "id": "gpt-image-2-all", "modality": "image"},
            {"name": "Sora 2", "id": "sora-2", "modality": "video"},
            {"name": "Nano Banana Pro", "id": "nano-banana-pro"},
        ],
        homepage_url="https://api.aggregator.test",
        docs_url=None,
        api_key_url=None,
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    )

    keys.add_key(spec)
    row = keys.find_by_alias("zz-general")

    assert row is not None
    assert row.provider == "custom"
    # 未标注（None）= 消费端按 key 级 modalities 兜底
    assert [m.modality for m in row.models] == ["image", "video", None]


def test_keyspec_ignores_legacy_routing_fields(isolated_data_root):
    """「分类 API」已删——旧 keys.json 里的 routing_* 字段静默忽略，不炸解析。"""
    spec = keys.KeySpec.model_validate({
        "alias": "old",
        "provider": "custom",
        "access_key": "x",
        "routing_scope": "classified",
        "routing_category": "gpt_image",
        "routing_hints": ["gpt-image"],
        "created_at": "2026-05-28T00:00:00+08:00",
    })
    assert spec.alias == "old"
    assert not hasattr(spec, "routing_scope")


def test_read_keys_db_migrates_legacy_zhenzhen_provider(isolated_data_root):
    data_root.keys_file().parent.mkdir(parents=True, exist_ok=True)
    data_root.keys_file().write_text(
        """
{
  "version": 1,
  "default_alias": "zz-general",
  "keys": [{
    "alias": "zz-general",
    "provider": "zhenzhen",
    "base_url": "https://api.aggregator.test",
    "access_key": "zz-secret",
    "secret_key": null,
    "capabilities": ["portrait"],
    "models": [],
    "routing_scope": "general",
    "routing_category": null,
    "routing_hints": [],
    "notes": "",
    "created_at": "2026-05-28T00:00:00+08:00"
  }]
}
""".strip(),
        encoding="utf-8",
    )

    row = keys.read_keys_db().keys[0]

    assert row.provider == "custom"
    assert row.base_url == "https://api.aggregator.test"


def test_find_by_alias(isolated_data_root):
    _seed({"version": 1, "default_alias": None, "keys": [
        {"alias": "a", "provider": "seedream", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    k = keys.find_by_alias("a")
    assert k.access_key == "x"
    assert keys.find_by_alias("missing") is None


def test_preferred_alias_returns_default_when_capability_matches(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "seedream", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait", "promo"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("portrait") == "a"


def test_preferred_alias_skips_default_when_capability_missing(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "openai", "access_key": "x", "secret_key": None,
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
        {"alias": "b", "provider": "seedream", "access_key": "y", "secret_key": "z",
         "capabilities": ["turnaround"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("turnaround") == "b"


def test_preferred_alias_returns_none_when_no_key_matches(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "openai", "access_key": "x", "secret_key": None,
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("promo") is None


def test_add_key_appends(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    db = keys.read_keys_db()
    assert len(db.keys) == 1
    assert db.keys[0].alias == "x"


def test_add_key_rejects_duplicate_alias(isolated_data_root):
    spec = keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    )
    keys.add_key(spec)
    with pytest.raises(keys.DuplicateAliasError):
        keys.add_key(spec)


def test_patch_key_updates_partial(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="old",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.patch_key("x", {"notes": "new", "capabilities": ["promo"]})
    k = keys.find_by_alias("x")
    assert k.notes == "new"
    assert k.capabilities == ["promo"]
    assert k.access_key == "a"


def test_patch_key_secret_preserved_when_not_provided(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="ak1", secret_key="sk1",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.patch_key("x", {"notes": "updated"})
    k = keys.find_by_alias("x")
    assert k.access_key == "ak1"
    assert k.secret_key == "sk1"


def test_delete_key_removes(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.delete_key("x")
    assert keys.find_by_alias("x") is None


def test_delete_key_clears_default_alias_if_deleted(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("x")
    keys.delete_key("x")
    db = keys.read_keys_db()
    assert db.default_alias is None


def test_set_default_alias_validates_existence(isolated_data_root):
    with pytest.raises(keys.NoSuchAliasError):
        keys.set_default_alias("nonexistent")


def test_keys_file_chmod_600_on_posix(isolated_data_root):
    import sys
    if sys.platform == "win32":
        pytest.skip("POSIX-only test")
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    mode = oct(data_root.keys_file().stat().st_mode & 0o777)
    assert mode == "0o600"


def test_modelspec_protocol_field_roundtrips():
    from character_workflow.lib.keys import ModelSpec
    m = ModelSpec(name="可灵", id="kling-v2-6", modality="video", protocol="kling")
    assert m.protocol == "kling"
    # 缺省为 None（图片模型 / 旧数据）
    assert ModelSpec(name="x", id="x").protocol is None
    # 旧 JSON（无 protocol 键）仍可校验
    assert ModelSpec.model_validate({"name": "a", "id": "a", "modality": "image"}).protocol is None


def test_read_keys_db_backfills_video_protocol(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="td", provider="tokendance",
        base_url="https://tokendance.space/gateway/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
        models=[
            keys.ModelSpec(name="Seedance", id="doubao-seedance-2-0", modality="video"),
            keys.ModelSpec(name="HappyHorse", id="happyhorse-1.0-t2v", modality="video"),
            keys.ModelSpec(name="Seedream", id="seedream-5.0-lite", modality="image"),
        ],
    ))
    db = keys.read_keys_db()
    by_id = {m.id: m for m in db.keys[0].models}
    assert by_id["doubao-seedance-2-0"].protocol == "seedance"
    assert by_id["happyhorse-1.0-t2v"].protocol == "dashscope"
    # 图片模型不回填
    assert by_id["seedream-5.0-lite"].protocol is None


def test_backfill_skips_unresolvable_custom_video(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="cu", provider="custom", base_url="https://api.example.com/v1",
        access_key="x", created_at="2026-06-23T00:00:00Z",
        models=[keys.ModelSpec(name="Foo", id="foo-video-1", modality="video")],
    ))
    db = keys.read_keys_db()
    assert db.keys[0].models[0].protocol is None  # 无法解析 → 待用户显式选
