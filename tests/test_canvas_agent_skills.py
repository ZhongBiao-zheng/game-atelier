"""画布 Agent Skill：导入（zip / 文件夹 / 单文件）的路径闸门、读取与 HTTP 管理入口。"""
from __future__ import annotations

import io
import stat
import zipfile

import pytest

from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib.canvas_tool_common import CanvasToolError
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient

SKILL_MD = """---
name: Three_View
description: >
  三视图出图流程
---
# 三视图
先读 references/pose.md。
""".encode()


@pytest.fixture(autouse=True)
def empty_builtin_root(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "BUILTIN_ROOT", tmp_path / "empty-builtins")


def _zip(entries: dict[str, bytes], symlink: str | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/etc/passwd")
    return buffer.getvalue()


def test_zip_with_wrapper_folder_installs_and_reads(isolated_data_root):
    files = skills.files_from_zip(_zip({
        "three-view/SKILL.md": SKILL_MD,
        "three-view/references/pose.md": "正面、侧面、背面".encode(),
        "three-view/scripts/render.py": b"print(1)",
        "__MACOSX/three-view/._SKILL.md": b"junk",
    }))
    info = skills.install_skill(files)
    assert info.name == "three-view"  # 名称取 frontmatter，下划线归一成短横线
    assert info.description == "三视图出图流程"
    assert info.has_scripts is True
    body = skills.read_skill("three-view")
    assert body.startswith("# 三视图") and "- references/pose.md" in body
    assert skills.read_skill_file("three-view", "references/pose.md") == "正面、侧面、背面"
    assert "three-view：三视图出图流程" in skills.skills_prompt()

    with pytest.raises(CanvasToolError) as exists:
        skills.install_skill(files)
    assert exists.value.code == "SKILL_EXISTS"
    assert skills.install_skill(files, replace=True).name == "three-view"


@pytest.mark.parametrize("name", ["../evil/SKILL.md", "/abs/SKILL.md", "C:/x/SKILL.md",
                                  "a/../../SKILL.md"])
def test_zip_entries_cannot_escape(isolated_data_root, name):
    with pytest.raises(CanvasToolError):
        skills.files_from_zip(_zip({name: SKILL_MD}))
    assert not (isolated_data_root / "evil").exists()


def test_symlink_and_case_collisions_are_rejected(isolated_data_root):
    with pytest.raises(CanvasToolError):
        skills.files_from_zip(_zip({"SKILL.md": SKILL_MD}, symlink="link"))
    with pytest.raises(CanvasToolError):
        skills.install_skill({"SKILL.md": SKILL_MD, "Readme.md": b"a", "README.md": b"b"})


def test_read_skill_file_stays_inside_the_skill(isolated_data_root):
    skills.install_skill({"SKILL.md": SKILL_MD})
    for path in ["../../.config/keys.json", "/etc/passwd"]:
        with pytest.raises(CanvasToolError):
            skills.read_skill_file("three-view", path)
    with pytest.raises(CanvasToolError):
        skills.read_skill("../three-view")


def test_missing_frontmatter_is_a_clear_error(isolated_data_root):
    with pytest.raises(CanvasToolError) as error:
        skills.install_skill({"SKILL.md": b"# no frontmatter"})
    assert "name / description" in error.value.message


def test_http_import_folder_list_and_delete(isolated_data_root):
    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")) as client:
        imported = client.post(
            "/api/canvas/agent/skills/import",
            files=[("files", ("SKILL.md", SKILL_MD, "text/markdown")),
                   ("files", ("pose.md", "正面".encode(), "text/markdown"))],
            data={"paths": ["my-skill/SKILL.md", "my-skill/references/pose.md"]},
        )
        assert imported.status_code == 200, imported.json()
        assert imported.json() == {"name": "three-view", "description": "三视图出图流程",
                                   "has_scripts": False, "builtin": False}
        assert [row["name"] for row in client.get("/api/canvas/agent/skills").json()["skills"]] \
            == ["three-view"]
        assert client.delete("/api/canvas/agent/skills/three-view").status_code == 204
        assert client.get("/api/canvas/agent/skills").json() == {"skills": []}


def test_builtin_skills_are_readonly_and_load_independently(isolated_data_root, monkeypatch):
    from pathlib import Path
    monkeypatch.setattr(skills, "BUILTIN_ROOT", Path(__file__).parent / "fixtures/agent_skills")
    skills.install_skill({"SKILL.md": SKILL_MD})
    assert [s.builtin for s in skills.list_skills()] == [True, False]
    result = skills.load_skills(["missing", "model-fixture", "three-view"])["skills"]
    assert "error" in result[0]
    assert '<skill name="model-fixture">' in result[1]["content"]
    assert "references/layout.md" in result[1]["content"]
    assert "description:" not in result[2]["content"]
    assert "正面" in skills.read_skill_file("model-fixture", "references/layout.md")
    with pytest.raises(CanvasToolError, match="内置"):
        skills.delete_skill("model-fixture")
    with pytest.raises(CanvasToolError, match="改名"):
        skills.install_skill({"SKILL.md": SKILL_MD.replace(b"Three_View", b"model-fixture")}, replace=True)


@pytest.mark.parametrize("studio", [False, True])
def test_workspace_prompt_includes_core_mode_and_skills(isolated_data_root, monkeypatch, studio):
    from types import SimpleNamespace
    from character_workflow.lib import canvas_agent_runtime as runtime, studio_agent
    skills.install_skill({"SKILL.md": SKILL_MD})
    monkeypatch.setattr(runtime.team_library_specs, "agent_instructions", lambda _: "")
    workspace = studio_agent.StudioWorkspace("test", None) if studio else runtime.CanvasWorkspace("p", "s")
    prompt = workspace.instructions(SimpleNamespace(creation_mode="image"))
    assert runtime.CORE in prompt
    assert ("## 创作台" if studio else "## 画布操作") in prompt
    assert "three-view" in prompt
    # 画布 Agent 去掉了创作模式（D14），只有创作台还按模式加提示。
    assert ("图像创作" in prompt) is studio
