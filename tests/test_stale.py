"""A3: stale 传播 —— 指纹盖章 / spec·style 变更后定稿标过时 / 重定稿自愈 / API 带标记。"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.__main__ import main
from character_workflow.lib import canonical, projects, stale, ui_jobs
from character_workflow.lib.schemas import AssetSlot
from viewer_server.server_app import build_app

SPEC_V1 = "## visual_dna\n- 发色: 银白\n\n## anchors\n- 瞳色: 金\n"
SPEC_V2 = "## visual_dna\n- 发色: 玄黑\n\n## anchors\n- 瞳色: 金\n"
STYLE_V1 = "---\nproject: mohuan\nstatus: approved\n---\n\n## style\n- render: 厚涂\n"
STYLE_V2 = "---\nproject: mohuan\nstatus: approved\n---\n\n## style\n- render: 赛璐璐\n"


@pytest.fixture
def hero(isolated_data_root):
    """已归属项目 mohuan 的角色 hero，带 spec + 一张可定稿立绘。"""
    proj = projects.create_project("魔幻", slug="mohuan")
    projects.assign_character("hero", proj.id)
    (isolated_data_root / "projects" / "mohuan" / "style.md").write_text(
        STYLE_V1, encoding="utf-8",
    )
    d = isolated_data_root / "characters" / "hero"
    (d / "portrait").mkdir(parents=True)
    (d / "spec.md").write_text(SPEC_V1, encoding="utf-8")
    (d / "portrait" / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    return proj


@pytest.fixture
def screen_home(isolated_data_root, hero):
    d = isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "screens" / "home"
    d.mkdir(parents=True)
    (d / "v1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (d.parent.parent / "style.md").write_text(STYLE_V1, encoding="utf-8")
    return d


# ---------- 指纹 ----------

def test_style_fingerprint_missing_file_is_empty(isolated_data_root):
    assert stale.style_fingerprint_for_slug("nope") == ""


def test_style_fingerprint_changes_with_content(isolated_data_root, hero):
    fp1 = stale.style_fingerprint_for_slug("mohuan")
    (isolated_data_root / "projects" / "mohuan" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    fp2 = stale.style_fingerprint_for_slug("mohuan")
    assert fp1 and fp2 and fp1 != fp2


def test_unassigned_character_style_fingerprint_empty(isolated_data_root):
    assert stale.style_fingerprint_for_character("nobody") == ""


def test_set_canonical_stamps_both_fingerprints(isolated_data_root, hero):
    file = canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    assert file.portrait.spec_fingerprint == canonical.spec_fingerprint("hero")
    assert file.portrait.style_fingerprint == stale.style_fingerprint_for_slug("mohuan")


# ---------- 角色定稿 stale ----------

def test_fresh_canonical_not_stale(isolated_data_root, hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    status = stale.character_canonical_status("hero")
    assert status.portrait.spec_stale is False
    assert status.portrait.style_stale is False


def test_spec_anchor_change_marks_spec_stale(isolated_data_root, hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    (isolated_data_root / "characters" / "hero" / "spec.md").write_text(SPEC_V2, encoding="utf-8")
    status = stale.character_canonical_status("hero")
    assert status.portrait.spec_stale is True
    assert status.portrait.style_stale is False


def test_style_change_marks_style_stale(isolated_data_root, hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    (isolated_data_root / "projects" / "mohuan" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    status = stale.character_canonical_status("hero")
    assert status.portrait.spec_stale is False
    assert status.portrait.style_stale is True


def test_reset_canonical_self_heals(isolated_data_root, hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    (isolated_data_root / "characters" / "hero" / "spec.md").write_text(SPEC_V2, encoding="utf-8")
    assert stale.character_canonical_status("hero").portrait.spec_stale is True
    # 重新定稿 → 盖新指纹 → 不再 stale
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    assert stale.character_canonical_status("hero").portrait.spec_stale is False


def test_legacy_empty_fingerprint_not_stale(isolated_data_root, hero):
    """旧数据没有指纹（""）无从比对 → 不误报，重定稿即自愈。"""
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    cfile = isolated_data_root / "characters" / "hero" / "canonical.json"
    data = json.loads(cfile.read_text())
    data["portrait"]["spec_fingerprint"] = ""
    data["portrait"]["style_fingerprint"] = ""
    cfile.write_text(json.dumps(data), encoding="utf-8")
    status = stale.character_canonical_status("hero")
    assert status.portrait.spec_stale is False
    assert status.portrait.style_stale is False


# ---------- screen 定稿 stale ----------

def test_screen_canonical_style_stale_and_heal(isolated_data_root, hero, screen_home):
    ui_jobs.set_screen_canonical(hero.id, "v1", "home", str(screen_home / "v1.png"))
    assert stale.screen_canonical_status(hero.id, "v1").screens["home"].style_stale is False

    (isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    assert stale.screen_canonical_status(hero.id, "v1").screens["home"].style_stale is True

    # B3 回写 style.md 后重跑 set-screen-canonical 刷新指纹 → 自愈
    ui_jobs.set_screen_canonical(hero.id, "v1", "home", str(screen_home / "v1.png"))
    assert stale.screen_canonical_status(hero.id, "v1").screens["home"].style_stale is False


# ---------- stale-report ----------

def test_stale_report_lists_only_stale(isolated_data_root, hero, screen_home):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    ui_jobs.set_screen_canonical(hero.id, "v1", "home", str(screen_home / "v1.png"))
    assert stale.stale_report() == {"characters": {}, "screens": {}}

    (isolated_data_root / "characters" / "hero" / "spec.md").write_text(SPEC_V2, encoding="utf-8")
    report = stale.stale_report()
    assert report["characters"]["hero"]["portrait"]["spec_stale"] is True
    assert report["screens"] == {}

    (isolated_data_root / "projects" / "mohuan" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    (isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    report = stale.stale_report()
    assert report["characters"]["hero"]["portrait"]["style_stale"] is True
    assert report["screens"]["mohuan"]["v1"]["home"]["style_stale"] is True


def test_cli_stale_report(isolated_data_root, hero, capsys):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    (isolated_data_root / "characters" / "hero" / "spec.md").write_text(SPEC_V2, encoding="utf-8")
    assert main(["stale-report"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["characters"]["hero"]["portrait"]["spec_stale"] is True


# ---------- API ----------

def test_api_canonical_carries_stale_flags(isolated_data_root, hero):
    canonical.set_canonical("hero", AssetSlot.PORTRAIT, "characters/hero/portrait/v1.png")
    (isolated_data_root / "characters" / "hero" / "spec.md").write_text(SPEC_V2, encoding="utf-8")
    client = TestClient(build_app())
    body = client.get("/api/characters/hero/canonical").json()
    assert body["portrait"]["spec_stale"] is True
    assert body["portrait"]["style_stale"] is False


def test_api_post_canonical_returns_fresh_status(isolated_data_root, hero):
    client = TestClient(build_app())
    body = client.post(
        "/api/characters/hero/canonical",
        json={"slot": "portrait", "path": "characters/hero/portrait/v1.png"},
    ).json()
    assert body["portrait"]["spec_stale"] is False
    # 取消定稿仍返回状态表
    body = client.post(
        "/api/characters/hero/canonical", json={"slot": "portrait", "path": None},
    ).json()
    assert body["portrait"] is None


def test_api_screen_canonical_carries_style_stale(isolated_data_root, hero, screen_home):
    ui_jobs.set_screen_canonical(hero.id, "v1", "home", str(screen_home / "v1.png"))
    (isolated_data_root / "projects" / "mohuan" / "ui" / "v1" / "style.md").write_text(
        STYLE_V2, encoding="utf-8",
    )
    client = TestClient(build_app())
    body = client.get(f"/api/projects/{hero.id}/ui-schemes/v1/screens/canonical").json()
    assert body["screens"]["home"]["style_stale"] is True
