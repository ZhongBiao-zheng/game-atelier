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
            "provider": "lovart",
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


def test_find_by_alias(isolated_data_root):
    _seed({"version": 1, "default_alias": None, "keys": [
        {"alias": "a", "provider": "lovart", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    k = keys.find_by_alias("a")
    assert k.access_key == "x"
    assert keys.find_by_alias("missing") is None


def test_preferred_alias_returns_default_when_capability_matches(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "lovart", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait", "promo"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("portrait") == "a"


def test_preferred_alias_skips_default_when_capability_missing(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "openai", "access_key": "x", "secret_key": None,
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
        {"alias": "b", "provider": "lovart", "access_key": "y", "secret_key": "z",
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
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    db = keys.read_keys_db()
    assert len(db.keys) == 1
    assert db.keys[0].alias == "x"


def test_add_key_rejects_duplicate_alias(isolated_data_root):
    spec = keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    )
    keys.add_key(spec)
    with pytest.raises(keys.DuplicateAliasError):
        keys.add_key(spec)


def test_patch_key_updates_partial(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
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
        alias="x", provider="lovart", access_key="ak1", secret_key="sk1",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.patch_key("x", {"notes": "updated"})
    k = keys.find_by_alias("x")
    assert k.access_key == "ak1"
    assert k.secret_key == "sk1"


def test_delete_key_removes(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.delete_key("x")
    assert keys.find_by_alias("x") is None


def test_delete_key_clears_default_alias_if_deleted(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
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
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    mode = oct(data_root.keys_file().stat().st_mode & 0o777)
    assert mode == "0o600"
