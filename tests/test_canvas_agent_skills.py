"""画布 Agent Skill：导入（zip / 文件夹 / 单文件）的路径闸门、读取与 HTTP 管理入口。"""
from __future__ import annotations

import io
import stat
import zipfile

import pytest

from character_workflow.lib import canvas_agent_skills as skills
from character_workflow.lib.workshop import WorkshopError
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

    with pytest.raises(WorkshopError) as exists:
        skills.install_skill(files)
    assert exists.value.code == "SKILL_EXISTS"
    assert skills.install_skill(files, replace=True).name == "three-view"


@pytest.mark.parametrize("name", ["../evil/SKILL.md", "/abs/SKILL.md", "C:/x/SKILL.md",
                                  "a/../../SKILL.md"])
def test_zip_entries_cannot_escape(isolated_data_root, name):
    with pytest.raises(WorkshopError):
        skills.files_from_zip(_zip({name: SKILL_MD}))
    assert not (isolated_data_root / "evil").exists()


def test_symlink_and_case_collisions_are_rejected(isolated_data_root):
    with pytest.raises(WorkshopError):
        skills.files_from_zip(_zip({"SKILL.md": SKILL_MD}, symlink="link"))
    with pytest.raises(WorkshopError):
        skills.install_skill({"SKILL.md": SKILL_MD, "Readme.md": b"a", "README.md": b"b"})


def test_read_skill_file_stays_inside_the_skill(isolated_data_root):
    skills.install_skill({"SKILL.md": SKILL_MD})
    for path in ["../../.config/keys.json", "/etc/passwd"]:
        with pytest.raises(WorkshopError):
            skills.read_skill_file("three-view", path)
    with pytest.raises(WorkshopError):
        skills.read_skill("../three-view")


def test_missing_frontmatter_is_a_clear_error(isolated_data_root):
    with pytest.raises(WorkshopError) as error:
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
                                   "has_scripts": False}
        assert [row["name"] for row in client.get("/api/canvas/agent/skills").json()["skills"]] \
            == ["three-view"]
        assert client.delete("/api/canvas/agent/skills/three-view").status_code == 204
        assert client.get("/api/canvas/agent/skills").json() == {"skills": []}
