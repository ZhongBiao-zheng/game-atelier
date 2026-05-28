from character_workflow.lib import keys
from character_workflow.lib.callers import zhenzhen_keys


def _add(
    alias: str,
    *,
    scope: str,
    category: str | None,
    access_key: str,
    routing_hints: list[str] | None = None,
) -> None:
    keys.add_key(
        keys.KeySpec(
            alias=alias,
            provider="custom",
            base_url="https://ai.t8star.org",
            access_key=access_key,
            secret_key=None,
            capabilities=["portrait", "promo", "turnaround"],
            models=[],
            routing_scope=scope,
            routing_category=category,
            routing_hints=routing_hints or [],
            modalities=["image"],
            notes="",
            created_at="2026-05-28T00:00:00+08:00",
        )
    )


def test_classify_model_hint_covers_supported_categories():
    assert zhenzhen_keys.classify_model_hint("gpt-image-2-all") == "gpt_image"
    assert zhenzhen_keys.classify_model_hint("nano-banana-pro") == "nano_banana"
    assert zhenzhen_keys.classify_model_hint("midjourney") == "mj"
    assert zhenzhen_keys.classify_model_hint("veo3") == "veo"
    assert zhenzhen_keys.classify_model_hint("grok imagine") == "grok"
    assert zhenzhen_keys.classify_model_hint("seedance") == "seedance"
    assert zhenzhen_keys.classify_model_hint("suno chirp") == "suno"


def test_pick_key_prefers_classified_gpt_key(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="gpt-image-2-all")

    assert picked.alias == "zz-gpt"
    assert picked.access_key == "gpt-key"


def test_pick_key_uses_routing_hints_for_classified_key(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add(
        "zz-custom-gpt",
        scope="classified",
        category="nano_banana",
        access_key="hint-key",
        routing_hints=["gpt-image-2-all"],
    )

    picked = zhenzhen_keys.pick_key(model_hint="gpt-image-2-all")

    assert picked.alias == "zz-custom-gpt"
    assert picked.access_key == "hint-key"


def test_pick_key_falls_back_to_general_when_classified_missing(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")

    picked = zhenzhen_keys.pick_key(model_hint="nano-banana-pro")

    assert picked.alias == "zz-general"
    assert picked.access_key == "general-key"


def test_pick_key_allows_classified_only_without_general(isolated_data_root):
    _add("zz-mj", scope="classified", category="mj", access_key="mj-key")

    picked = zhenzhen_keys.pick_key(model_hint="midjourney")

    assert picked.alias == "zz-mj"
    assert picked.access_key == "mj-key"


def test_pick_key_uses_explicit_general_alias_when_no_classified_match(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="unknown-model", alias="zz-general")

    assert picked.alias == "zz-general"
    assert picked.access_key == "general-key"


def test_pick_key_upgrades_explicit_general_alias_to_classified_key(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="gpt-image-2-all", alias="zz-general")

    assert picked.alias == "zz-gpt"
    assert picked.access_key == "gpt-key"


def test_pick_key_keeps_explicit_classified_alias(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="nano-banana-pro", alias="zz-gpt")

    assert picked.alias == "zz-gpt"
    assert picked.access_key == "gpt-key"


def test_pick_key_raises_clear_error_when_no_key(isolated_data_root):
    try:
        zhenzhen_keys.pick_key(model_hint="gpt-image-2-all")
    except zhenzhen_keys.ZhenzhenKeyError as e:
        assert "未配置" in str(e)
    else:
        raise AssertionError("expected ZhenzhenKeyError")


def test_task_alias_memory_roundtrip():
    zhenzhen_keys.remember_task_alias("task-1", "zz-gpt")

    assert zhenzhen_keys.recall_task_alias("task-1") == "zz-gpt"
