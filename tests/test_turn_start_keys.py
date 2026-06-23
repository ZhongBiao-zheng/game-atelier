from character_workflow.lib import keys
from character_workflow.lib.turn_start import turn_start


def _seed_keys() -> None:
    keys.add_key(keys.KeySpec(
        alias="lov", provider="seedream", access_key="ak", secret_key="sk",
        capabilities=["portrait", "promo"], models=["gpt_image_2"],
        notes="主力", created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.add_key(keys.KeySpec(
        alias="oa", provider="openai", access_key="x", secret_key=None,
        capabilities=["portrait"], models=[],
        notes="便宜", created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("lov")


def test_turn_start_includes_available_keys_without_secrets(isolated_data_root):
    _seed_keys()
    out = turn_start(kind="portrait")
    assert "available_keys" in out
    assert len(out["available_keys"]) == 2
    for k in out["available_keys"]:
        assert "access_key" not in k
        assert "secret_key" not in k
    assert out["preferred_alias"] == "lov"
    assert out["available_keys"][0]["models"] == [
        {"name": "gpt_image_2", "id": "gpt_image_2", "modality": None, "protocol": None}
    ]


def test_turn_start_preferred_alias_skips_when_capability_mismatch(isolated_data_root):
    _seed_keys()
    out = turn_start(kind="turnaround")
    assert out["preferred_alias"] is None


def test_turn_start_no_keys_returns_empty_and_null(isolated_data_root):
    out = turn_start(kind="portrait")
    assert out["available_keys"] == []
    assert out["preferred_alias"] is None
