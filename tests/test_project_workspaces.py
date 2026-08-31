from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.projects import assign_character, create_project
from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root: Path) -> TestClient:
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_workspace_summary_is_derived_from_project_files(client, isolated_data_root):
    project = create_project("三国")
    assign_character("cao-cao", project.id)
    root = isolated_data_root / "projects" / project.slug
    for name in ("gdd", "prd", "interaction"):
        _write(root / "design" / f"{name}.md", "---\nstatus: approved\n---\n")
    _write(
        root / "ui" / "v1" / "style.md",
        "---\nstatus: approved\n---\n\n## ui.typography\n- body: Geist\n",
    )
    _write(root / "ui" / "v1" / "screens" / "screen-map.md", "---\nstatus: approved\n---\n")
    _write(root / "ui" / "v1" / "screens" / "home" / "v1.png", "image")
    _write(root / "ui" / "v1" / "screens" / "home" / "v2.png", "image")

    response = client.get(f"/api/projects/{project.id}/workspaces")

    assert response.status_code == 200
    data = response.json()
    assert data["art"]["characters"] == 1
    assert data["ui"] == {
        "scheme_id": "v1",
        "anchors": {"gdd": "approved", "prd": "approved", "interaction": "approved"},
        "anchors_approved": 3,
        "style_status": "approved",
        "has_ui_style": True,
        "screen_map_status": "approved",
        "screens": 1,
        "versions": 2,
        "canonical": 0,
        "stale": 0,
        "screen_items": [],
        "next_action": "完成风格定稿",
        "next_command": "/game-atelier:ui-page",
    }


def test_workspace_summary_recommends_only_the_first_missing_gate(client):
    project = create_project("空项目")

    data = client.get(f"/api/projects/{project.id}/workspaces").json()

    assert data["ui"]["anchors_approved"] == 0
    assert data["ui"]["next_action"] == "建立并批准 UI 策划锚"
    assert data["ui"]["next_command"] == "/game-atelier:ui-anchor"
    assert data["video"]["productions"] == 0
    assert data["video"]["versions"] == 0
    assert data["video"]["selected"] == 0


def test_workspace_summary_reports_completed_ui_scope(client, isolated_data_root):
    project = create_project("完成项目")
    root = isolated_data_root / "projects" / project.slug
    for name in ("gdd", "prd", "interaction"):
        _write(root / "design" / f"{name}.md", "---\nstatus: approved\n---\n")
    _write(root / "ui" / "v1" / "style.md", "---\nstatus: approved\n---\n\n## ui.color\n")
    _write(
        root / "ui" / "v1" / "screens" / "screen-map.md",
        "---\nstatus: approved\n---\n\n"
        "| screen-id | 名称 | 分类 | 优先级 | 状态 | 依赖 |\n"
        "|---|---|---|---|---|---|\n"
        "| home | 主界面 | core | must-have | canonical | |\n",
    )
    image = root / "ui" / "v1" / "screens" / "home" / "v1.png"
    _write(image, "image")
    selected = client.post(
        f"/api/projects/{project.id}/ui-schemes/v1/screens/canonical",
        json={"screen_id": "home", "path": image.relative_to(isolated_data_root).as_posix()},
    )

    assert selected.status_code == 200
    ui = client.get(f"/api/projects/{project.id}/workspaces").json()["ui"]
    assert ui["canonical"] == 1
    assert ui["next_action"] == "复核 UI 页面交付"
    assert ui["next_command"] == "/game-atelier:ui"


def test_workspace_summary_reads_screen_map_contract(client, isolated_data_root):
    project = create_project("三国")
    screen_map = isolated_data_root / "projects" / project.slug / "ui" / "v1" / "screens" / "screen-map.md"
    _write(
        screen_map,
        "---\nstatus: approved\n---\n\n"
        "| screen-id | 名称 | 分类 | 优先级 | 状态 | 依赖 |\n"
        "|---|---|---|---|---|---|\n"
        "| home | 主界面 | core | must-have | planned | |\n\n"
        "## screen.home\n- purpose: 进入游戏后的功能总览\n",
    )
    _write(
        screen_map.parent / "home.md",
        "---\nproject: sanguo\nscreen: home\n---\n\n"
        "## 定位\n- 页面目标: 让玩家查看全部核心功能入口\n",
    )

    ui = client.get(f"/api/projects/{project.id}/workspaces").json()["ui"]

    assert ui["screens"] == 1
    assert ui["screen_items"] == [{
        "screen_id": "home",
        "name": "主界面",
        "category": "core",
        "priority": "must-have",
        "status": "planned",
        "dependency": "",
        "purpose": "进入游戏后的功能总览",
        "brief_summary": "让玩家查看全部核心功能入口",
    }]


def test_workspace_summary_rejects_unknown_project(client):
    response = client.get("/api/projects/missing/workspaces")

    assert response.status_code == 404
