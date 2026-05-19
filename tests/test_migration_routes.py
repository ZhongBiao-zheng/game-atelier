"""Regression: characters/<id>.md → characters/<id>/spec.md 破坏性目录迁移。

迁移前这些断言全 FAIL；迁移完成后全 PASS。等价于 plan §11.4 的
test_migration_routes + test_migration_gallery 合并（后者改 Python API
测试覆盖，因为 web 还没装 vitest jsdom 框架）。
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from skill.viewer_server.server_app import build_app


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    (runtime / "draft").mkdir()
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    # 新结构：characters/<id>/spec.md
    chars = tmp_path / "characters" / "shadow"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 暗影刺客女\n年龄: 24", encoding="utf-8")
    (chars / "portrait").mkdir()
    (chars / "promo").mkdir()
    (chars / "turnaround").mkdir()
    (chars / "source").mkdir()
    monkeypatch.chdir(tmp_path)
    return runtime


@pytest.fixture
def client(runtime):
    return TestClient(build_app())


def test_get_spec_reads_from_nested_dir(client):
    """GET /api/spec/<id> 必须能从 characters/<id>/spec.md 读出来。"""
    r = client.get("/api/spec/shadow")
    assert r.status_code == 200, r.json()
    assert "暗影刺客女" in r.json()["content"]


def test_get_spec_404_when_dir_missing(client):
    r = client.get("/api/spec/nonexistent")
    assert r.status_code == 404


def test_post_spec_writes_into_nested_dir(client):
    """POST /api/spec/<id> 必须落到 characters/<id>/spec.md。"""
    r = client.post("/api/spec/shadow", json={"content": "# 新名\n新内容"})
    assert r.status_code == 200, r.json()
    p = Path.cwd() / "characters" / "shadow" / "spec.md"
    assert p.exists(), f"spec.md not at {p}"
    assert p.read_text(encoding="utf-8") == "# 新名\n新内容"


def test_post_spec_creates_dir_for_new_character(client):
    """新角色第一次保存 spec，目录应自动创建。"""
    r = client.post("/api/spec/brand-new", json={"content": "# 新角色"})
    assert r.status_code == 200
    p = Path.cwd() / "characters" / "brand-new" / "spec.md"
    assert p.exists()


def test_get_characters_lists_nested_dirs(client):
    """GET /api/characters 用目录而不是 .md 字面量发现角色。"""
    r = client.get("/api/characters")
    assert r.status_code == 200
    entries = r.json()
    ids = [c["id"] for c in entries]
    assert "shadow" in ids, f"shadow missing in {ids}"
    by_id = {c["id"]: c for c in entries}
    assert by_id["shadow"]["name"] == "暗影刺客女"


def test_get_characters_ignores_top_level_md_files(client, runtime, tmp_path):
    """旧扁平 characters/foo.md 不应被列入（已迁移后只识别 dir/spec.md）。"""
    stray = tmp_path / "characters" / "leftover.md"
    stray.write_text("# 残留旧文件")
    r = client.get("/api/characters")
    ids = [c["id"] for c in r.json()]
    assert "leftover" not in ids, f"stray md leaked into listing: {ids}"


def test_rename_character_writes_into_nested_spec(client):
    """POST /api/characters/<id>/rename 改 characters/<id>/spec.md 第一行。"""
    r = client.post("/api/characters/shadow/rename", json={"name": "暗影"})
    assert r.status_code == 200, r.json()
    p = Path.cwd() / "characters" / "shadow" / "spec.md"
    text = p.read_text(encoding="utf-8")
    assert text.startswith("# 暗影")
    assert "年龄: 24" in text


def test_rename_character_404_for_missing_dir(client):
    r = client.post("/api/characters/nope/rename", json={"name": "x"})
    assert r.status_code == 404


def test_gallery_data_flow_via_api(client, runtime):
    """画廊 = GET /api/characters + GET /api/jobs?character_id 的组合。
    迁移后这条链路必须仍然能返回正确数据。"""
    (runtime / "jobs" / "j1.json").write_text(json.dumps({
        "job_id": "j1", "character_id": "shadow", "prompt": "p",
        "submitted_at": "2026-05-19T10:00:00Z", "model": "gpt_image_2",
        "params": {}, "seed": None,
        "output_paths": [str(Path.cwd() / "characters" / "shadow" / "portrait" / "v1.png")],
        "status": "done", "error": None,
    }))
    r1 = client.get("/api/characters")
    assert any(c["id"] == "shadow" for c in r1.json())
    r2 = client.get("/api/jobs")
    assert r2.status_code == 200
    jobs = [j for j in r2.json() if j["character_id"] == "shadow"]
    assert len(jobs) == 1
    assert jobs[0]["output_paths"][0].endswith("/portrait/v1.png")
