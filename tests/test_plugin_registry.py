"""插件清单、注册表与启用状态（ADR-0037）。"""
from __future__ import annotations

import json
import threading

import pytest
from pydantic import ValidationError

from character_workflow.lib import plugin_registry
from character_workflow.lib.plugin_manifest import PluginManifest, PluginPackageLock, package_digest
from tests.plugin_fixtures import UI_HTML, lock_for, manifest, use_plugins_root, write_plugin


@pytest.fixture
def root(tmp_path, monkeypatch):
    path = tmp_path / "plugins"
    use_plugins_root(monkeypatch, path)
    return path


def by_id(plugin_id: str) -> dict:
    return next(item for item in plugin_registry.list_plugins() if item["id"] == plugin_id)


def test_valid_manifest_parses():
    parsed = PluginManifest.model_validate(manifest())
    assert parsed.contributes.nodes[0].type == "demo"


@pytest.mark.parametrize("patch", [
    {"id": "Bad_ID"},
    {"version": "1.0"},
    {"unknown_field": 1},
    {"ui": None},  # 声明了节点却没有界面
    {"contributes": {"image_actions": [{
        "id": "go", "label": "去", "icon": "grid",
        "action": {"kind": "create_node", "node_type": "missing"},
    }]}},
    {"contributes": {"server": {"module": "server", "routes": [
        {"method": "POST", "path": "/detect", "access": "read"},
    ]}, "agent_tools": [{
        "name": "detect", "description": "x", "parameters": {}, "read_only": True, "route": "/other",
    }]}},
])
def test_invalid_manifest_is_rejected(patch):
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(manifest(**patch))


def test_manifest_missing_required_field_is_rejected():
    source = manifest()
    del source["name"]
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(source)


def test_lock_requires_ui_entry_in_files():
    with pytest.raises(ValidationError):
        PluginPackageLock.model_validate(lock_for(manifest(), {}))


def test_lock_rejects_path_traversal():
    lock = lock_for(manifest(), {"ui/index.html": UI_HTML})
    lock["files"].append({"path": "ui/../../secret", "sha256": "0" * 64, "bytes": 1})
    with pytest.raises(ValidationError):
        PluginPackageLock.model_validate(lock)


def test_digest_ignores_key_order_and_its_own_field():
    lock = lock_for(manifest(), {"ui/index.html": UI_HTML})
    reordered = dict(reversed(list(lock.items())))
    assert package_digest(reordered) == lock["digest"]


def test_scan_lists_valid_plugin_as_disabled(root):
    write_plugin(root)
    item = by_id("demo")
    assert item["availability"] == "ok" and item["enabled"] is False
    assert item["manifest"]["name"] == "演示插件"


def test_no_plugins_directory_means_empty_list(tmp_path, monkeypatch):
    use_plugins_root(monkeypatch, tmp_path / "plugins")
    (tmp_path / "plugins").rmdir()
    assert plugin_registry.list_plugins() == []


def test_broken_manifest_only_affects_itself(root):
    write_plugin(root)
    broken = root / "broken" / "package"
    broken.mkdir(parents=True)
    (broken / "manifest.lock.json").write_text("{not json", encoding="utf-8")
    assert by_id("demo")["availability"] == "ok"
    assert by_id("broken")["availability"] == "invalid"
    assert by_id("broken")["manifest"] is None and by_id("broken")["reason"]


def test_tampered_lock_is_invalid(root):
    lock = lock_for(manifest(), {"ui/index.html": UI_HTML})
    write_plugin(root, lock={**lock, "name": "被改过"})
    assert by_id("demo")["availability"] == "invalid"


def test_id_must_match_directory(root):
    write_plugin(root, "demo", lock=lock_for(manifest("other"), {"ui/index.html": UI_HTML}))
    assert by_id("demo")["availability"] == "invalid"


@pytest.mark.parametrize("overrides, reason", [
    ({"app_version": {"min": "9.0.0"}}, "需要 Atelier 9.0.0 以上"),
    ({"app_version": {"min": "1.0.0", "max": "2.0.0"}}, "仅支持到 Atelier 2.0.0"),
    ({"sdk_version": "2"}, "需要更高版本的 Atelier"),
    ({"capabilities": ["generation.image"]}, "需要更高版本的 Atelier"),
    ({"assets": [{"id": "model", "title": "模型", "urls": ["https://example.com/m.bin"],
                  "bytes": 10, "sha256": "a" * 64}]}, "需要更高版本的 Atelier"),
])
def test_incompatible_plugin_cannot_be_enabled(root, overrides, reason):
    write_plugin(root, **overrides)
    item = by_id("demo")
    assert item["availability"] == "incompatible" and item["reason"] == reason
    with pytest.raises(plugin_registry.PluginError) as error:
        plugin_registry.set_enabled("demo", True)
    assert error.value.code == "PLUGIN_UNAVAILABLE"
    assert plugin_registry.enabled_ids() == set()


def test_enable_and_disable_persist(root, isolated_data_root):
    write_plugin(root)
    plugin_registry.set_enabled("demo", True)
    stored = json.loads((isolated_data_root / ".config" / "plugins.json").read_text(encoding="utf-8"))
    assert stored["schema_version"] == 1
    assert stored["plugins"]["demo"]["enabled"] is True
    assert stored["plugins"]["demo"]["digest"].startswith("sha256:")
    assert plugin_registry.enabled_ids() == {"demo"}
    plugin_registry.set_enabled("demo", False)
    assert plugin_registry.enabled_ids() == set()
    assert by_id("demo")["enabled"] is False


def test_enable_unknown_plugin_is_404(root):
    with pytest.raises(plugin_registry.PluginError) as error:
        plugin_registry.set_enabled("ghost", True)
    assert error.value.status == 404


def test_corrupt_state_falls_back_to_all_disabled_and_keeps_the_file(root, isolated_data_root):
    write_plugin(root)
    state = isolated_data_root / ".config" / "plugins.json"
    state.write_text("{broken", encoding="utf-8")
    assert by_id("demo")["enabled"] is False
    assert not state.exists()
    kept = list(state.parent.glob("plugins.json.broken-*"))
    assert len(kept) == 1 and kept[0].read_text(encoding="utf-8") == "{broken"
    plugin_registry.set_enabled("demo", True)
    assert plugin_registry.enabled_ids() == {"demo"}


def test_bad_entry_is_skipped_and_unknown_plugin_entry_is_kept(root, isolated_data_root):
    write_plugin(root)
    state = isolated_data_root / ".config" / "plugins.json"
    state.write_text(json.dumps({"schema_version": 1, "plugins": {
        "demo": {"enabled": "yes"}, "removed-plugin": {"enabled": True},
    }}), encoding="utf-8")
    assert plugin_registry.enabled_ids() == set()
    plugin_registry.set_enabled("demo", True)
    stored = json.loads(state.read_text(encoding="utf-8"))["plugins"]
    assert stored["removed-plugin"] == {"enabled": True}
    assert stored["demo"]["enabled"] is True


def test_enabled_record_does_not_enable_a_plugin_that_became_invalid(root):
    package = write_plugin(root)
    plugin_registry.set_enabled("demo", True)
    (package / "manifest.lock.json").write_text("{}", encoding="utf-8")
    assert plugin_registry.enabled_ids() == set()
    assert by_id("demo")["enabled"] is False


def test_concurrent_toggles_keep_both_entries(root):
    write_plugin(root, "one")
    write_plugin(root, "two")
    threads = [threading.Thread(target=plugin_registry.set_enabled, args=(name, True))
               for name in ("one", "two") for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert plugin_registry.enabled_ids() == {"one", "two"}


def test_package_file_requires_enabled_plugin_and_listed_path(root):
    package = write_plugin(root)
    (package / "unlisted.txt").write_text("x", encoding="utf-8")
    with pytest.raises(plugin_registry.PluginError) as disabled:
        plugin_registry.package_file("demo", "ui/index.html")
    assert disabled.value.code == "PLUGIN_DISABLED"
    plugin_registry.set_enabled("demo", True)
    assert plugin_registry.package_file("demo", "ui/index.html").read_bytes() == UI_HTML
    for path in ("unlisted.txt", "manifest.lock.json", "../../../pyproject.toml"):
        with pytest.raises(plugin_registry.PluginError) as missing:
            plugin_registry.package_file("demo", path)
        assert missing.value.code == "PLUGIN_FILE_NOT_FOUND"
