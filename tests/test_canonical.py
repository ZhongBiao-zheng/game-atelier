"""A2 canonical 定稿 —— lib/canonical.py + CLI + API。"""
import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import canonical
from character_workflow.lib.schemas import AssetSlot

SPEC = """---
id: hero
name: Hero
---

## visual_dna
- style: 卡通
- palette: 红 / 白

## anchors
1. 红色围巾
2. 白发

## asset.portrait
- size: 1024x1536
"""


@pytest.fixture
def hero(isolated_data_root):
    char = isolated_data_root / "characters" / "hero"
    (char / "portrait").mkdir(parents=True)
    (char / "spec.md").write_text(SPEC, encoding="utf-8")
    (char / "portrait" / "v1.png").write_bytes(b"png1")
    (char / "portrait" / "v2.png").write_bytes(b"png2")
    return isolated_data_root


def test_read_missing_returns_empty(hero):
    file = canonical.read_canonical("hero")
    assert file.portrait is None and file.promo is None and file.turnaround is None


def test_set_canonical_relative_path(hero):
    file = canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v2.png")
    assert file.portrait is not None
    assert file.portrait.path == "characters/hero/portrait/v2.png"
    assert file.portrait.set_at
    assert file.portrait.spec_fingerprint != ""
    # 落盘可回读
    again = canonical.read_canonical("hero")
    assert again.portrait is not None and again.portrait.path.endswith("v2.png")


def test_set_canonical_absolute_path_normalized(hero):
    abs_path = hero / "characters" / "hero" / "portrait" / "v1.png"
    file = canonical.set_canonical("hero", AssetSlot.PORTRAIT, str(abs_path))
    assert file.portrait is not None
    assert file.portrait.path == "characters/hero/portrait/v1.png"


def test_set_canonical_replaces_previous(hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    file = canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v2.png")
    assert file.portrait is not None and file.portrait.path.endswith("v2.png")


def test_set_canonical_missing_file_raises(hero):
    with pytest.raises(FileNotFoundError):
        canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v9.png")


def test_set_canonical_outside_slot_dir_raises(hero):
    # 其他角色 / 其他 slot 的文件不能标为本角色本 slot 定稿
    other = hero / "characters" / "hero" / "promo"
    other.mkdir()
    (other / "v1.png").write_bytes(b"png")
    with pytest.raises(ValueError):
        canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/promo/v1.png")


def test_clear_canonical(hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    file = canonical.clear_canonical("hero", AssetSlot.PORTRAIT)
    assert file.portrait is None


def test_corrupt_canonical_treated_as_empty(hero):
    p = hero / "characters" / "hero" / "canonical.json"
    p.write_text("{not json", encoding="utf-8")
    assert canonical.read_canonical("hero").portrait is None


def test_spec_fingerprint_changes_with_anchors(hero):
    fp1 = canonical.spec_fingerprint("hero")
    spec_path = hero / "characters" / "hero" / "spec.md"
    spec_path.write_text(SPEC.replace("红色围巾", "蓝色围巾"), encoding="utf-8")
    fp2 = canonical.spec_fingerprint("hero")
    assert fp1 != fp2


def test_spec_fingerprint_ignores_asset_sections(hero):
    fp1 = canonical.spec_fingerprint("hero")
    spec_path = hero / "characters" / "hero" / "spec.md"
    spec_path.write_text(SPEC.replace("1024x1536", "1536x1024"), encoding="utf-8")
    assert canonical.spec_fingerprint("hero") == fp1


def test_spec_fingerprint_missing_spec(isolated_data_root):
    assert canonical.spec_fingerprint("nobody") == ""


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def test_cli_set_and_clear(hero, capsys):
    from character_workflow.__main__ import main

    rc = main([
        "set-canonical", "--kind", "portrait",
        "--path", "characters/hero/portrait/v1.png", "--character", "hero",
    ])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["portrait"]["path"] == "characters/hero/portrait/v1.png"

    rc = main(["set-canonical", "--kind", "portrait", "--clear", "--character", "hero"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["portrait"] is None


def test_cli_missing_path_errors(hero, capsys):
    from character_workflow.__main__ import main
    rc = main(["set-canonical", "--kind", "portrait", "--character", "hero"])
    assert rc == 1
    assert "error" in json.loads(capsys.readouterr().out)


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@pytest.fixture
def client(hero):
    from viewer_server.server_app import build_app
    return TestClient(build_app())


def test_api_get_empty(client):
    r = client.get("/api/characters/hero/canonical")
    assert r.status_code == 200
    assert r.json() == {"portrait": None, "promo": None, "turnaround": None}


def test_api_set_and_clear(client):
    r = client.post(
        "/api/characters/hero/canonical",
        json={"slot": "portrait", "path": "characters/hero/portrait/v2.png"},
    )
    assert r.status_code == 200
    assert r.json()["portrait"]["path"] == "characters/hero/portrait/v2.png"

    r = client.post("/api/characters/hero/canonical", json={"slot": "portrait", "path": None})
    assert r.status_code == 200
    assert r.json()["portrait"] is None


def test_api_set_missing_file_404(client):
    r = client.post(
        "/api/characters/hero/canonical",
        json={"slot": "portrait", "path": "characters/hero/portrait/v9.png"},
    )
    assert r.status_code == 404


def test_api_set_outside_slot_400(client, hero):
    (hero / "characters" / "hero" / "promo").mkdir(exist_ok=True)
    (hero / "characters" / "hero" / "promo" / "v1.png").write_bytes(b"png")
    r = client.post(
        "/api/characters/hero/canonical",
        json={"slot": "portrait", "path": "characters/hero/promo/v1.png"},
    )
    assert r.status_code == 400
